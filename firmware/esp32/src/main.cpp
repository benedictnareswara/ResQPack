#include <Arduino.h>
#include <MQTT.h>
#include <WiFi.h>
#include <time.h>

// UART link from Mega Serial2 -> ESP32 Serial2.
static const int BRIDGE_RX_PIN = 16;
static const int BRIDGE_TX_PIN = 17;
static const uint32_t BRIDGE_BAUD = 115200;
static const size_t BRIDGE_LINE_BUFFER_SIZE = 180;
static const uint32_t WIFI_RETRY_MS = 5000;
static const uint32_t MQTT_RETRY_MS = 4000;
static const uint32_t HEARTBEAT_MS = 30000;
static const size_t EVENT_QUEUE_CAPACITY = 24;
static const uint32_t NTP_RETRY_MS = 5000;
static const time_t MIN_VALID_EPOCH = 1700000000;

// This gateway deliberately has no fallback coordinate. Coordinates are forwarded
// exactly as the Mega sent them: the last known fix when one has gone stale, or 0,0
// when the device has never had one. `valid == 0` is the signal that the position is
// not a measurement, and choosing what to show instead is the dashboard's job — it
// can be changed there at runtime rather than requiring a reflash. Do not reintroduce
// a substitution here; two owners of the same decision is how they drift apart.

#ifndef WIFI_SSID
#define WIFI_SSID "YOUR_WIFI_SSID"
#endif

#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#endif

#ifndef MQTT_BROKER
#define MQTT_BROKER "broker.hivemq.com"
#endif

#ifndef MQTT_PORT
#define MQTT_PORT 1883
#endif

#ifndef MQTT_USERNAME
#define MQTT_USERNAME ""
#endif

#ifndef MQTT_PASSWORD
#define MQTT_PASSWORD ""
#endif

#ifndef DEVICE_ID
#define DEVICE_ID "resqpack-esp32-01"
#endif

WiFiClient gNetClient;
MQTTClient gMqttClient(1024);

struct BridgeEvent {
  uint32_t seq;
  bool valid;
  float lat;
  float lon;
  unsigned long ageMs;
  float tiltDeg;
  float accelG;
  char eventType[20];
  unsigned long receivedMs;
};

BridgeEvent gEventQueue[EVENT_QUEUE_CAPACITY];
size_t gQueueHead = 0;
size_t gQueueTail = 0;
size_t gQueueCount = 0;
uint32_t gDroppedEventCount = 0;

unsigned long gLastWiFiAttemptMs = 0;
unsigned long gLastMqttAttemptMs = 0;
unsigned long gLastHeartbeatMs = 0;
unsigned long gLastNtpAttemptMs = 0;
bool gNtpConfigured = false;
bool gNtpSynced = false;
bool gLoggedUnsyncedTsWarning = false;

char gLine[BRIDGE_LINE_BUFFER_SIZE];
size_t gLinePos = 0;

// Topics and the Last Will payload live at file scope on purpose: the MQTT client
// keeps pointers to the will buffers rather than copying them, so they must outlive
// the setWill() call. Never build these on the stack.
char gEventTopic[96];
char gStatusTopic[96];
char gWillPayload[96];

bool isAcceptedEventType(const char *eventType) {
  return strcmp(eventType, "MANUAL") == 0 ||
         strcmp(eventType, "CRASH_CONFIRMED") == 0;
}

void buildTopics() {
  snprintf(gEventTopic, sizeof(gEventTopic), "resqpack/v1/devices/%s/events", DEVICE_ID);
  snprintf(gStatusTopic, sizeof(gStatusTopic), "resqpack/v1/devices/%s/status", DEVICE_ID);
  snprintf(gWillPayload, sizeof(gWillPayload), "{\"device\":\"%s\",\"online\":0}", DEVICE_ID);
}

// One shape for every status write (connect, heartbeat, Last Will) so the dashboard
// only has to understand a single payload. Always published retained, so a dashboard
// that loads later immediately learns the device's state.
void buildStatusPayload(char *payload, size_t size, bool online) {
  snprintf(payload,
           size,
           "{\"device\":\"%s\",\"online\":%d,\"wifi\":%d,\"queue\":%u,\"dropped\":%lu,\"uptime_ms\":%lu}",
           DEVICE_ID,
           online ? 1 : 0,
           WiFi.status() == WL_CONNECTED ? 1 : 0,
           static_cast<unsigned int>(gQueueCount),
           static_cast<unsigned long>(gDroppedEventCount),
           millis());
}

void enqueueEvent(const BridgeEvent &event) {
  if (gQueueCount == EVENT_QUEUE_CAPACITY) {
    // Drop oldest when full so latest critical events can still enter.
    gQueueHead = (gQueueHead + 1) % EVENT_QUEUE_CAPACITY;
    gQueueCount--;
    gDroppedEventCount++;
  }

  gEventQueue[gQueueTail] = event;
  gQueueTail = (gQueueTail + 1) % EVENT_QUEUE_CAPACITY;
  gQueueCount++;
}

bool dequeueEvent(BridgeEvent &outEvent) {
  if (gQueueCount == 0) {
    return false;
  }
  outEvent = gEventQueue[gQueueHead];
  gQueueHead = (gQueueHead + 1) % EVENT_QUEUE_CAPACITY;
  gQueueCount--;
  return true;
}

bool peekEvent(BridgeEvent &outEvent) {
  if (gQueueCount == 0) {
    return false;
  }
  outEvent = gEventQueue[gQueueHead];
  return true;
}

void printEvent(const BridgeEvent &event, const char *prefix) {
  Serial.print(prefix);
  Serial.print(" seq=");
  Serial.print(event.seq);
  Serial.print(" type=");
  Serial.print(event.eventType);
  Serial.print(" valid=");
  Serial.print(event.valid ? 1 : 0);
  Serial.print(" lat=");
  Serial.print(event.lat, 6);
  Serial.print(" lon=");
  Serial.print(event.lon, 6);
  Serial.print(" ageMs=");
  Serial.print(event.ageMs);
  Serial.print(" tilt=");
  Serial.print(event.tiltDeg, 2);
  Serial.print(" accelG=");
  Serial.println(event.accelG, 3);
}

void buildEventJson(const BridgeEvent &event, char *json, size_t jsonSize) {
  time_t nowSec = time(nullptr);
  uint64_t tsMs = 0;
  if (nowSec >= MIN_VALID_EPOCH) {
    tsMs = static_cast<uint64_t>(nowSec) * 1000ULL;
    gNtpSynced = true;
    gLoggedUnsyncedTsWarning = false;
  }

  // received_ms is the device's own monotonic clock. It is the only usable ordering
  // signal before NTP syncs, when ts_ms is still 0.
  snprintf(json, jsonSize,
           "{\"device\":\"%s\",\"seq\":%lu,\"event\":\"%s\",\"valid\":%d,\"lat\":"
           "%.6f,\"lon\":%.6f,\"ts_ms\":%llu,\"received_ms\":%lu,\"age_ms\":%lu,"
           "\"accel_g\":%.3f}",
           DEVICE_ID, static_cast<unsigned long>(event.seq), event.eventType,
           event.valid ? 1 : 0, static_cast<double>(event.lat),
           static_cast<double>(event.lon),
           static_cast<unsigned long long>(tsMs),
           static_cast<unsigned long>(event.receivedMs),
           static_cast<unsigned long>(event.ageMs),
           static_cast<double>(event.accelG));
}

void ensureTimeSynced() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  const unsigned long nowMs = millis();
  if (!gNtpConfigured) {
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    gNtpConfigured = true;
    gLastNtpAttemptMs = nowMs;
    Serial.println("NTP: configuration requested");
  }

  const time_t nowSec = time(nullptr);
  if (nowSec >= MIN_VALID_EPOCH) {
    if (!gNtpSynced) {
      gNtpSynced = true;
      Serial.print("NTP: synced epoch=");
      Serial.println(static_cast<unsigned long>(nowSec));
    }
    return;
  }

  if (nowMs - gLastNtpAttemptMs >= NTP_RETRY_MS) {
    gLastNtpAttemptMs = nowMs;
    Serial.println("NTP: waiting for valid time...");
  }
}

void publishHeartbeat() {
  if (!gMqttClient.connected()) {
    return;
  }
  if (millis() - gLastHeartbeatMs < HEARTBEAT_MS) {
    return;
  }
  gLastHeartbeatMs = millis();

  char payload[200];
  buildStatusPayload(payload, sizeof(payload), true);
  gMqttClient.publish(gStatusTopic, payload, true, 1);
}

void ensureWiFiConnected() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  if (millis() - gLastWiFiAttemptMs < WIFI_RETRY_MS) {
    return;
  }
  gLastWiFiAttemptMs = millis();

  Serial.println("WiFi: attempting connect...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void ensureMqttConnected() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  if (gMqttClient.connected()) {
    return;
  }

  if (millis() - gLastMqttAttemptMs < MQTT_RETRY_MS) {
    return;
  }
  gLastMqttAttemptMs = millis();

  Serial.println("MQTT: attempting connect...");
  const bool connected =
      gMqttClient.connect(DEVICE_ID, MQTT_USERNAME, MQTT_PASSWORD);
  if (!connected) {
    Serial.println("MQTT: connect failed");
    return;
  }

  Serial.println("MQTT: connected");
  char payload[200];
  buildStatusPayload(payload, sizeof(payload), true);
  gMqttClient.publish(gStatusTopic, payload, true, 1);
  gLastHeartbeatMs = millis();
}

void publishQueuedEvent() {
  if (!gMqttClient.connected()) {
    return;
  }

  BridgeEvent event;
  if (!peekEvent(event)) {
    return;
  }

  char payload[420];
  buildEventJson(event, payload, sizeof(payload));
  if (!gNtpSynced && !gLoggedUnsyncedTsWarning) {
    Serial.println("MQTT: time not synced yet, publishing ts_ms=0");
    gLoggedUnsyncedTsWarning = true;
  }
  Serial.print("MQTT payload: ");
  Serial.println(payload);
  // Retained: a dashboard opened after the crash still receives the latest incident.
  const bool ok = gMqttClient.publish(gEventTopic, payload, true, 1);
  if (!ok) {
    Serial.println("MQTT: publish failed, will retry");
    return;
  }

  BridgeEvent emitted;
  if (dequeueEvent(emitted)) {
    printEvent(emitted, "MQTT published");
  }
}

bool parseLegacyGpsLine(char *line, uint32_t &seq, bool &valid, float &lat,
                        float &lon, unsigned long &ageMs) {
  char *token = strtok(line, ",");
  if (token == nullptr || strcmp(token, "GPS") != 0) {
    return false;
  }

  token = strtok(nullptr, ",");
  if (token == nullptr) {
    return false;
  }
  seq = static_cast<uint32_t>(strtoul(token, nullptr, 10));

  token = strtok(nullptr, ",");
  if (token == nullptr) {
    return false;
  }
  valid = (atoi(token) == 1);

  token = strtok(nullptr, ",");
  if (token == nullptr) {
    return false;
  }
  lat = static_cast<float>(atof(token));

  token = strtok(nullptr, ",");
  if (token == nullptr) {
    return false;
  }
  lon = static_cast<float>(atof(token));

  token = strtok(nullptr, ",");
  if (token == nullptr) {
    return false;
  }
  ageMs = static_cast<unsigned long>(strtoul(token, nullptr, 10));

  return true;
}

bool parseEventLine(char *line, uint32_t &seq, bool &valid, float &lat,
                    float &lon, unsigned long &ageMs, char *eventType,
                    size_t eventTypeSize, float &tiltDeg, float &accelG) {
  char *token = strtok(line, ",");
  if (token == nullptr || strcmp(token, "EVT") != 0) {
    return false;
  }

  token = strtok(nullptr, ",");
  if (token == nullptr) {
    return false;
  }
  seq = static_cast<uint32_t>(strtoul(token, nullptr, 10));

  token = strtok(nullptr, ",");
  if (token == nullptr) {
    return false;
  }
  strncpy(eventType, token, eventTypeSize - 1);
  eventType[eventTypeSize - 1] = '\0';

  token = strtok(nullptr, ",");
  if (token == nullptr) {
    return false;
  }
  valid = (atoi(token) == 1);

  token = strtok(nullptr, ",");
  if (token == nullptr) {
    return false;
  }
  lat = static_cast<float>(atof(token));

  token = strtok(nullptr, ",");
  if (token == nullptr) {
    return false;
  }
  lon = static_cast<float>(atof(token));

  token = strtok(nullptr, ",");
  if (token == nullptr) {
    return false;
  }
  ageMs = static_cast<unsigned long>(strtoul(token, nullptr, 10));

  token = strtok(nullptr, ",");
  if (token == nullptr) {
    return false;
  }
  tiltDeg = static_cast<float>(atof(token));

  token = strtok(nullptr, ",");
  if (token == nullptr) {
    return false;
  }
  accelG = static_cast<float>(atof(token));

  return true;
}

bool parseAnyEventLine(char *line, BridgeEvent &event) {
  uint32_t seq = 0;
  bool valid = false;
  float lat = 0.0f;
  float lon = 0.0f;
  unsigned long ageMs = 0;

  if (strncmp(line, "EVT,", 4) == 0) {
    float tiltDeg = 0.0f;
    float accelG = 0.0f;
    char eventType[20] = {0};
    if (!parseEventLine(line, seq, valid, lat, lon, ageMs, eventType,
                        sizeof(eventType), tiltDeg, accelG)) {
      return false;
    }
    if (!isAcceptedEventType(eventType)) {
      return false;
    }
    event.seq = seq;
    event.valid = valid;
    event.lat = lat;
    event.lon = lon;
    event.ageMs = ageMs;
    event.tiltDeg = tiltDeg;
    event.accelG = accelG;
    strncpy(event.eventType, eventType, sizeof(event.eventType) - 1);
    event.eventType[sizeof(event.eventType) - 1] = '\0';
    event.receivedMs = millis();
    return true;
  }

  if (strncmp(line, "GPS,", 4) == 0) {
    if (!parseLegacyGpsLine(line, seq, valid, lat, lon, ageMs)) {
      return false;
    }
    event.seq = seq;
    event.valid = valid;
    event.lat = lat;
    event.lon = lon;
    event.ageMs = ageMs;
    event.tiltDeg = 0.0f;
    event.accelG = 0.0f;
    strncpy(event.eventType, "GPS_LEGACY", sizeof(event.eventType) - 1);
    event.eventType[sizeof(event.eventType) - 1] = '\0';
    event.receivedMs = millis();
    return true;
  }

  return false;
}

void handleBridgeLine(char *line) {
  if (line[0] == '\0') {
    return;
  }

  BridgeEvent event;
  if (parseAnyEventLine(line, event)) {
    printEvent(event, "RX");
    enqueueEvent(event);
    return;
  }

  Serial.print("Unknown or invalid bridge line: ");
  Serial.println(line);
}

void handleBridgeByte(char c) {
  if (c == '\r') {
    return;
  }

  if (c == '\n') {
    gLine[gLinePos] = '\0';
    handleBridgeLine(gLine);
    gLinePos = 0;
    return;
  }

  if (gLinePos < sizeof(gLine) - 1) {
    gLine[gLinePos++] = c;
  } else {
    gLinePos = 0;
  }
}

void setup() {
  Serial.begin(115200);
#if defined(ARDUINO_ARCH_ESP32)
  Serial2.begin(BRIDGE_BAUD, SERIAL_8N1, BRIDGE_RX_PIN, BRIDGE_TX_PIN);
#else
  Serial2.begin(BRIDGE_BAUD);
#endif

  buildTopics();

  WiFi.mode(WIFI_STA);
  gMqttClient.begin(MQTT_BROKER, MQTT_PORT, gNetClient);

  // Must be registered before any connect(). The broker publishes this on our behalf
  // if we drop off without a clean disconnect, which is how the dashboard learns a
  // device died rather than simply going quiet.
  gMqttClient.setWill(gStatusTopic, gWillPayload, true, 1);

  delay(200);
  Serial.println("ESP32 bridge MQTT gateway ready");
  Serial.print("Event topic:  ");
  Serial.println(gEventTopic);
  Serial.print("Status topic: ");
  Serial.println(gStatusTopic);
  Serial.println("Waiting for Mega bridge packets and network connection...");
}

void loop() {
  while (Serial2.available() > 0) {
    handleBridgeByte(static_cast<char>(Serial2.read()));
  }

  ensureWiFiConnected();
  ensureTimeSynced();
  gMqttClient.loop();
  ensureMqttConnected();
  publishQueuedEvent();
  publishHeartbeat();
}

// Entry point. Samples the accelerometer every 100 ms and watches for the crash
// pattern: a spike past GFORCE_SPIKE_THRESHOLD_G followed by a stop under
// GFORCE_STOP_THRESHOLD_G within GFORCE_SPIKE_WINDOW_MS. A match drives the
// safety state machine, which owns the buzzer, the cancel window and publishing.
#include <Arduino.h>

#include "app_config.hpp"
#include "bridge_protocol.hpp"
#include "button_input.hpp"
#include "gps_parser.hpp"
#include "i2c_bitbang.hpp"
#include "mpu6050.hpp"
#include "safety_fsm.hpp"
#include "types.hpp"

namespace {

// Timing state for MPU polling
unsigned long gLastMpuReadMs = 0;

// G-force spike → stop crash detection state
bool gSpikeActive = false;
unsigned long gSpikeDetectedMs = 0;
float gSpikeAccelG = 0.0f;

// Magnitude actually reported to the ESP32. It tracks the live reading, but latches
// to the spike peak once a crash pattern completes and holds it until the alert is
// cleared. Without the latch we would publish the resting ~1g sampled 5 seconds
// after impact, since the FSM only emits once the cancel window expires.
float gReportAccelG = 0.0f;
bool gCrashPeakLatched = false;

void setBuzzer(bool enabled) {
  if (enabled) {
    tone(BUZZER_PIN, BUZZER_TONE_HZ);
  } else {
    noTone(BUZZER_PIN);
    digitalWrite(BUZZER_PIN, LOW);
  }
}

// Evaluates the two-phase crash pattern:
// Phase 1: Detect a G-force spike above GFORCE_SPIKE_THRESHOLD_G
// Phase 2: Within GFORCE_SPIKE_WINDOW_MS, detect a drop below
// GFORCE_STOP_THRESHOLD_G Returns true when the full spike→stop pattern
// completes (i.e., crash detected).
bool evaluateCrashPattern(float accelMagnitudeG) {
  if (!gSpikeActive) {
    if (accelMagnitudeG < GFORCE_SPIKE_THRESHOLD_G) {
      return false;
    }
    gSpikeActive = true;
    gSpikeDetectedMs = millis();
    gSpikeAccelG = accelMagnitudeG;
    Serial.print("SPIKE detected: ");
    Serial.print(accelMagnitudeG, 3);
    Serial.println("g");
    return false;
  }

  // Phase 2: spike is active — check for sudden stop within time window
  const unsigned long elapsed = millis() - gSpikeDetectedMs;

  if (elapsed > GFORCE_SPIKE_WINDOW_MS) {
    gSpikeActive = false;
    Serial.print("SPIKE expired: no stop within ");
    Serial.print(GFORCE_SPIKE_WINDOW_MS);
    Serial.println("ms, resetting");
    return false;
  }

  if (accelMagnitudeG > GFORCE_STOP_THRESHOLD_G) {
    return false;
  }

  // Spike followed by sudden stop within window → CRASH
  gSpikeActive = false;
  // Detection keeps running while an alert is pending, so a second, weaker pattern can
  // complete before the FSM publishes. Keep the largest peak seen during the alert —
  // the reported figure is meant to describe the impact, not the most recent jolt.
  if (!gCrashPeakLatched || gSpikeAccelG > gReportAccelG) {
    gReportAccelG = gSpikeAccelG;
  }
  gCrashPeakLatched = true;
  Serial.print("CRASH pattern: spike=");
  Serial.print(gSpikeAccelG, 3);
  Serial.print("g -> stop=");
  Serial.print(accelMagnitudeG, 3);
  Serial.print("g in ");
  Serial.print(elapsed);
  Serial.println("ms");
  return true;
}

void logMpuData(const MpuRawData &data, float accelMagnitudeG,
                bool crashTrigger) {
  Serial.print("ACC:");
  Serial.print(data.ax);
  Serial.print(',');
  Serial.print(data.ay);
  Serial.print(',');
  Serial.print(data.az);

  Serial.print(" G:");
  Serial.print(data.gx);
  Serial.print(',');
  Serial.print(data.gy);
  Serial.print(',');
  Serial.print(data.gz);

  Serial.print(" T:");
  Serial.print(rawTempToC(data.temp), 1);

  Serial.print(" |g|:");
  Serial.print(accelMagnitudeG, 3);

  if (gSpikeActive) {
    Serial.print(" SPK:");
    Serial.print(gSpikeAccelG, 3);
    Serial.print("/");
    Serial.print(millis() - gSpikeDetectedMs);
    Serial.print("ms");
  }

  if (crashTrigger) {
    Serial.print(" CRASH!");
  }

  Serial.print(" GPS:");
  if (hasFreshFix()) {
    const GpsFix &fix = getLatestFix();
    Serial.print(fix.latitude, 6);
    Serial.print(',');
    Serial.println(fix.longitude, 6);
  } else {
    Serial.println("--");
  }
}

void handleMpuNotReady() {
  static unsigned long lastMsgMs = 0;
  digitalWrite(LED_PIN, (millis() / 250) % 2);
  if (millis() - lastMsgMs < 1000) {
    return;
  }
  lastMsgMs = millis();
  Serial.println("MPU not ready. Fix wiring/address and press RESET.");
}

#if ENABLE_SERIAL_TEST_COMMANDS

const char *alertStateName(AlertState state) {
  switch (state) {
  case ALERT_STANDBY:
    return "STANDBY";
  case ALERT_CRASH_PENDING:
    return "CRASH_PENDING";
  case ALERT_CRASH_CONFIRMED:
    return "CRASH_CONFIRMED";
  default:
    return "UNKNOWN";
  }
}

void printFsmState() {
  const AlertState state = getAlertState();
  Serial.print("TEST STATE: ");
  Serial.print(alertStateName(state));
  if (state == ALERT_CRASH_PENDING) {
    Serial.print(" source=");
    Serial.print(getPendingSource() == PENDING_SOURCE_MANUAL ? "MANUAL" : "CRASH");
    Serial.print(" remaining_ms=");
    Serial.print(getPendingRemainingMs());
  }
  Serial.print(" report_g=");
  Serial.print(gReportAccelG, 3);
  Serial.print(" mpu=");
  Serial.print(isMpuReady() ? "ready" : "not_ready");
  Serial.print(" gps=");
  Serial.println(hasFreshFix() ? "fix" : "no_fix");
}

// Drains the console and reports what was asked for. Returns true for an injected
// crash trigger; sets outButtonEdge for an injected press. Several 'b' characters in
// one read collapse into a single edge, which is what a real button can produce.
bool pollSerialTestCommands(bool &outButtonEdge) {
  bool injectedCrash = false;

  while (Serial.available() > 0) {
    switch (static_cast<char>(Serial.read())) {
    case 'c':
    case 'C':
      injectedCrash = true;
      Serial.println("TEST: injected crash trigger");
      break;
    case 'b':
    case 'B':
      outButtonEdge = true;
      Serial.println("TEST: injected button press");
      break;
    case 's':
    case 'S':
      printFsmState();
      break;
    case '\r':
    case '\n':
    case ' ':
      break;
    default:
      Serial.println("TEST: c=inject crash  b=inject button  s=print state");
      break;
    }
  }

  return injectedCrash;
}

#endif // ENABLE_SERIAL_TEST_COMMANDS

} // namespace

void setup() {
  pinMode(LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  setBuzzer(false);

  Serial.begin(115200);
  Serial1.begin(GPS_BAUD);
  Serial2.begin(BRIDGE_BAUD);
  i2cInit();

  initButtonInput();
  initSafetyStateMachine();

  delay(300);
  Serial.println("ResQPack: Arduino Mega 2560 R3 + MPU6050 bring-up");
  Serial.print("Crash: spike>=");
  Serial.print(GFORCE_SPIKE_THRESHOLD_G, 1);
  Serial.print("g stop<=");
  Serial.print(GFORCE_STOP_THRESHOLD_G, 1);
  Serial.print("g in ");
  Serial.print(GFORCE_SPIKE_WINDOW_MS);
  Serial.println("ms | Cancel: 5s");

#if ENABLE_SERIAL_TEST_COMMANDS
  Serial.println("Test console: c=inject crash  b=inject button  s=print state");
#endif

  initMpu6050();
}

void loop() {
  processGpsStream();
  bool buttonPressed = detectButtonPressedEdge();
  bool injectedCrash = false;

#if ENABLE_SERIAL_TEST_COMMANDS
  injectedCrash = pollSerialTestCommands(buttonPressed);
#endif

  // Back in standby means the previous alert was cleared, so stop holding its peak.
  if (getAlertState() == ALERT_STANDBY) {
    gCrashPeakLatched = false;
  }

#if ENABLE_SERIAL_TEST_COMMANDS
  // Latch a plausible peak so an injected crash publishes the same shape of payload
  // a real one does. Must follow the standby reset above or it would be cleared.
  if (injectedCrash) {
    gReportAccelG = TEST_INJECTED_CRASH_G;
    gCrashPeakLatched = true;
  }
#endif

  // This call owns the button edge, and runs every iteration so the countdown and
  // button handling work at full rate rather than only on MPU sample ticks. It also
  // carries the console-injected trigger, which must work with no MPU attached.
  updateSafetyStateMachine(buttonPressed, injectedCrash, gReportAccelG, setBuzzer,
                           publishBridgeEvent);

  if (!isMpuReady()) {
    handleMpuNotReady();
    return;
  }

  if (millis() - gLastMpuReadMs < MPU_SAMPLE_INTERVAL_MS) {
    return;
  }
  gLastMpuReadMs = millis();

  MpuRawData data;
  if (!readMpuRaw(data)) {
    Serial.println("MPU read failed (I2C).");
    return;
  }

  digitalWrite(LED_PIN, !digitalRead(LED_PIN));
  const float accelMagnitudeG = computeAccelMagnitudeG(data);
  if (!gCrashPeakLatched) {
    gReportAccelG = accelMagnitudeG;
  }

  // Latches gReportAccelG to the spike peak when the pattern completes.
  const bool crashTrigger = evaluateCrashPattern(accelMagnitudeG);

  // Deliberately passes false for the button: the edge was already consumed by the
  // call above, and this second call exists only to deliver the accelerometer trigger.
  // Passing it again would apply one press twice in a single iteration — starting a
  // countdown and instantly cancelling it, or re-arming one just as it was cleared.
  updateSafetyStateMachine(false, crashTrigger, gReportAccelG, setBuzzer,
                           publishBridgeEvent);

  logMpuData(data, accelMagnitudeG, crashTrigger);
}

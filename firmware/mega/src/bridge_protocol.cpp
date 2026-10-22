// Wire format - frozen contract, and the only writer to Serial2. Builds the CSV
// line the ESP32's parseEventLine() expects; the field order, field count and
// separator are all part of that contract, so changing any of them means
// changing the ESP32 firmware and the dashboard in the same commit.
// See docs/PROTOCOL.md.
#include "bridge_protocol.hpp"

#include "gps_parser.hpp"

namespace {
uint32_t gBridgeSequence = 0;
}

void publishBridgeEvent(const char *eventType, float tiltDeg, float accelMagnitudeG) {
  const bool freshFix = hasFreshFix();
  const GpsFix &fix = getLatestFix();
  const unsigned long ageMs = freshFix ? (millis() - fix.updatedMs) : 0;

  // CSV event format for ESP32 parser (DO NOT MODIFY without updating docs/PROTOCOL.md):
  // EVT,<seq>,<event>,<valid>,<lat>,<lon>,<age_ms>,<tilt_deg>,<accel_g>
  Serial2.print("EVT,");
  Serial2.print(gBridgeSequence++);
  Serial2.print(',');
  Serial2.print(eventType);
  Serial2.print(',');
  Serial2.print(freshFix ? 1 : 0);
  Serial2.print(',');
  Serial2.print(fix.latitude, 6);
  Serial2.print(',');
  Serial2.print(fix.longitude, 6);
  Serial2.print(',');
  Serial2.print(ageMs);
  Serial2.print(',');
  Serial2.print(tiltDeg, 2);
  Serial2.print(',');
  Serial2.println(accelMagnitudeG, 3);

  Serial.print("ESP TX EVT=");
  Serial.print(eventType);
  Serial.print(" seq=");
  Serial.print(gBridgeSequence - 1);
  Serial.print(" gps_valid=");
  Serial.print(freshFix ? 1 : 0);
  Serial.print(" lat=");
  Serial.print(fix.latitude, 6);
  Serial.print(" lon=");
  Serial.print(fix.longitude, 6);
  Serial.print(" age_ms=");
  Serial.print(ageMs);
  Serial.print(" tilt_deg=");
  Serial.print(tiltDeg, 2);
  Serial.print(" accel_g=");
  Serial.println(accelMagnitudeG, 3);

  if (!freshFix) {
    Serial.println("ESP TX NOTE: GPS fix not fresh/valid; sent valid=0 with last known coordinates");
  }
}

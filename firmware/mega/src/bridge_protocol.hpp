// Wire format - frozen contract. The CSV line this produces is parsed by the
// ESP32 gateway and, once translated to JSON, by the dashboard. Changing this
// signature means changing all three. See docs/PROTOCOL.md.
#pragma once

#include <Arduino.h>

void publishBridgeEvent(const char *eventType, float tiltDeg, float accelMagnitudeG);

#pragma once

#include <Arduino.h>

struct GpsFix {
  bool valid;
  float latitude;
  float longitude;
  unsigned long updatedMs;
};

struct MpuRawData {
  int16_t ax;
  int16_t ay;
  int16_t az;
  int16_t temp;
  int16_t gx;
  int16_t gy;
  int16_t gz;
};

enum AlertState {
  ALERT_STANDBY,
  ALERT_CRASH_PENDING,
  ALERT_CRASH_CONFIRMED
};

enum PendingSource {
  PENDING_SOURCE_CRASH,
  PENDING_SOURCE_MANUAL
};

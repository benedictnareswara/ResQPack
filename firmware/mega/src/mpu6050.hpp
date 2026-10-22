// MPU6050 over the bit-banged bus: address probe, wake, raw burst read, and the
// |g| magnitude the crash detector works from.
#pragma once

#include <Arduino.h>

#include "types.hpp"

bool initMpu6050();
bool isMpuReady();
bool readMpuRaw(MpuRawData &data);

float computeAccelMagnitudeG(const MpuRawData &data);
float rawTempToC(int16_t rawTemp);

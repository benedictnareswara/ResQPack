// Streams bytes off Serial1 and keeps the latest valid fix. hasFreshFix() gates
// on GPS_FIX_STALE_MS.
#pragma once

#include <Arduino.h>

#include "types.hpp"

void processGpsStream();
bool hasFreshFix();
const GpsFix &getLatestFix();

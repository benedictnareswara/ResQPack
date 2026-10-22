// The alert state machine: STANDBY -> CRASH_PENDING -> CRASH_CONFIRMED. It takes
// the buzzer and publish actions as function pointers, so it depends on neither
// the buzzer nor the UART bridge.
#pragma once

#include <Arduino.h>

#include "types.hpp"

void initSafetyStateMachine();
void updateSafetyStateMachine(bool buttonPressed,
                              bool crashTrigger,
                              float lastAccelMagnitudeG,
                              void (*setBuzzer)(bool),
                              void (*publishEvent)(const char *, float, float));

AlertState getAlertState();

// Which trigger opened the current pending window. Only meaningful while the state
// is ALERT_CRASH_PENDING.
PendingSource getPendingSource();

// Milliseconds left in the cancel window, or 0 when no window is open. Read-only
// introspection for diagnostics; the FSM never consults it.
unsigned long getPendingRemainingMs();

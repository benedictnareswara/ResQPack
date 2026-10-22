// Debounced push-button edge detection: one press yields exactly one true.
#pragma once

#include <Arduino.h>

void initButtonInput();
bool detectButtonPressedEdge();

// Every pin, timing value and detection threshold in one place. Tune crash
// detection here rather than at the call sites.
#pragma once

#include <Arduino.h>

inline constexpr uint8_t LED_PIN = LED_BUILTIN;
inline constexpr uint8_t BUZZER_PIN = 6;
inline constexpr uint8_t BUTTON_PIN = 7;
inline constexpr uint16_t BUZZER_TONE_HZ = 1760;

inline constexpr uint32_t MPU_SAMPLE_INTERVAL_MS = 100;
inline constexpr uint32_t GPS_BAUD = 9600;
inline constexpr uint32_t BRIDGE_BAUD = 115200;
inline constexpr uint32_t GPS_FIX_STALE_MS = 10000;
inline constexpr uint32_t CRASH_CANCEL_WINDOW_MS = 5000;
inline constexpr uint32_t BUTTON_DEBOUNCE_MS = 40;
inline constexpr uint32_t EVENT_COOLDOWN_MS = 3000;

inline constexpr float MPU_ACCEL_LSB_PER_G = 16384.0f;

// I2C bit-bang configuration (Mega 2560: SDA=pin 20/PD1, SCL=pin 21/PD0)
// Recorded for the wiring diagram only. i2c_bitbang.cpp drives PD1/PD0 through the
// port registers directly, so changing these two numbers moves nothing.
inline constexpr uint8_t I2C_SDA_PIN = 20;
inline constexpr uint8_t I2C_SCL_PIN = 21;
inline constexpr uint8_t I2C_HALF_CYCLE_US = 5;  // ~100 kHz clock

// MPU6050 I2C addresses (AD0 pin selects between the two)
inline constexpr uint8_t MPU6050_DEFAULT_ADDRESS = 0x68;
inline constexpr uint8_t MPU6050_ALT_ADDRESS = 0x69;

// G-force impact detection thresholds
// A crash is detected when acceleration spikes above GFORCE_SPIKE_THRESHOLD_G
// and then drops below GFORCE_STOP_THRESHOLD_G within GFORCE_SPIKE_WINDOW_MS.
inline constexpr float GFORCE_SPIKE_THRESHOLD_G = 2.5f;
inline constexpr float GFORCE_STOP_THRESHOLD_G = 1.2f;
inline constexpr uint32_t GFORCE_SPIKE_WINDOW_MS = 500;

// Bench-test console on Serial. Lets every alert path be exercised from the serial
// monitor without producing a real 2.5 g impact — see docs/PROTOCOL.md.
//
// A test-injected crash is indistinguishable from a real one downstream: it drives the
// same state machine and publishes the same event to the live MQTT broker. That is the
// point of it, but set this to 0 for any build that will be worn rather than benched.
#define ENABLE_SERIAL_TEST_COMMANDS 1

// Impact magnitude reported for a console-injected crash. Above the spike threshold so
// the published payload looks like a plausible collision rather than an obvious stub.
inline constexpr float TEST_INJECTED_CRASH_G = 3.2f;

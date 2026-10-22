// Hand-rolled I2C master for the Mega 2560, open-drain on the AVR port
// registers at roughly 100 kHz. SDA = pin 20 (PD1), SCL = pin 21 (PD0).
#pragma once

#include <Arduino.h>

// Initializes the I2C bus pins and performs a bus recovery sequence
// (9 clock pulses) to release any slave holding SDA low.
void i2cInit();

// Writes a single byte to a register on the target device.
// Returns true on success (all ACKs received).
bool i2cWriteRegister(uint8_t deviceAddr, uint8_t reg, uint8_t value);

// Reads `length` consecutive bytes starting from `startReg`.
// Returns true on success (all ACKs received during address/register phase).
bool i2cReadBytes(uint8_t deviceAddr, uint8_t startReg, uint8_t *buffer, uint8_t length);

// Probes the bus for a device at the given 7-bit address.
// Returns true if the device ACKs its address.
bool i2cProbeAddress(uint8_t address);

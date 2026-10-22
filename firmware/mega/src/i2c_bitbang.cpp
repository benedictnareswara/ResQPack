// Open-drain I2C by hand on the Mega's port registers: driving a DDR bit to
// OUTPUT with its PORT bit at 0 pulls the line LOW, and returning DDR to INPUT
// lets the pull-up float it HIGH. 5 us half-cycles give roughly 100 kHz.
// Mega 2560-specific: SDA = PD1 (pin 20), SCL = PD0 (pin 21).
#include "i2c_bitbang.hpp"

#include <avr/io.h>
#include <util/delay.h>

#include "app_config.hpp"

namespace {

// --- AVR port register mappings for Mega 2560 I2C pins ---
// Pin 20 (SDA) = Port D, bit 1
// Pin 21 (SCL) = Port D, bit 0
volatile uint8_t *const SDA_DDR  = &DDRD;
volatile uint8_t *const SDA_PORT = &PORTD;
volatile uint8_t *const SDA_PIN_REG = &PIND;
constexpr uint8_t SDA_BIT = 1;

volatile uint8_t *const SCL_DDR  = &DDRD;
volatile uint8_t *const SCL_PORT = &PORTD;
volatile uint8_t *const SCL_PIN_REG = &PIND;
constexpr uint8_t SCL_BIT = 0;

// I2C R/W direction bits appended to the 7-bit device address
constexpr uint8_t I2C_WRITE_BIT = 0x00;
constexpr uint8_t I2C_READ_BIT  = 0x01;

// Number of recovery clock pulses to unstick a frozen slave
constexpr uint8_t BUS_RECOVERY_CLOCKS = 9;

// ---- Low-level GPIO primitives (open-drain) ----

// Release SDA (float HIGH via pull-up): set DDR to input, enable pull-up
inline void sdaHigh() {
  *SDA_DDR  &= ~(1 << SDA_BIT);  // input mode (high-Z)
  *SDA_PORT |=  (1 << SDA_BIT);  // enable internal pull-up
}

// Drive SDA LOW: disable pull-up first, then set DDR to output (PORT bit already 0)
inline void sdaLow() {
  *SDA_PORT &= ~(1 << SDA_BIT);  // ensure PORT bit is 0
  *SDA_DDR  |=  (1 << SDA_BIT);  // output mode → drives LOW
}

// Release SCL (float HIGH via pull-up): set DDR to input, enable pull-up
inline void sclHigh() {
  *SCL_DDR  &= ~(1 << SCL_BIT);
  *SCL_PORT |=  (1 << SCL_BIT);
}

// Drive SCL LOW: disable pull-up first, then set DDR to output
inline void sclLow() {
  *SCL_PORT &= ~(1 << SCL_BIT);
  *SCL_DDR  |=  (1 << SCL_BIT);
}

// Read the current logic level on SDA
inline bool readSda() {
  return (*SDA_PIN_REG & (1 << SDA_BIT)) != 0;
}

// Half-cycle delay for ~100 kHz I2C clock (5 µs high + 5 µs low = 10 µs period)
inline void halfCycleDelay() {
  delayMicroseconds(I2C_HALF_CYCLE_US);
}

// ---- I2C protocol primitives ----

void i2cStart() {
  // START condition: SDA goes LOW while SCL is HIGH
  sdaHigh();
  halfCycleDelay();
  sclHigh();
  halfCycleDelay();
  sdaLow();
  halfCycleDelay();
  sclLow();
  halfCycleDelay();
}

void i2cStop() {
  // STOP condition: SDA goes HIGH while SCL is HIGH
  sdaLow();
  halfCycleDelay();
  sclHigh();
  halfCycleDelay();
  sdaHigh();
  halfCycleDelay();
}

// Transmit one byte MSB-first. Returns true if slave sent ACK (SDA LOW on 9th clock).
bool i2cWriteByte(uint8_t data) {
  for (uint8_t bit = 0; bit < 8; bit++) {
    if (data & 0x80) {
      sdaHigh();
    } else {
      sdaLow();
    }
    data <<= 1;
    halfCycleDelay();
    sclHigh();
    halfCycleDelay();
    sclLow();
  }

  // Release SDA and read ACK/NACK on 9th clock
  sdaHigh();
  halfCycleDelay();
  sclHigh();
  halfCycleDelay();
  const bool ack = !readSda();  // ACK = SDA pulled LOW by slave
  sclLow();
  halfCycleDelay();
  return ack;
}

// Receive one byte MSB-first. Sends ACK if `sendAck` is true, NACK otherwise.
// The master must NACK the last byte of a read sequence per I2C protocol.
uint8_t i2cReadByte(bool sendAck) {
  uint8_t data = 0;
  sdaHigh();  // release SDA so slave can drive it

  for (uint8_t bit = 0; bit < 8; bit++) {
    data <<= 1;
    halfCycleDelay();
    sclHigh();
    halfCycleDelay();
    if (readSda()) {
      data |= 0x01;
    }
    sclLow();
  }

  // Send ACK (SDA LOW) or NACK (SDA HIGH) on 9th clock
  if (sendAck) {
    sdaLow();
  } else {
    sdaHigh();
  }
  halfCycleDelay();
  sclHigh();
  halfCycleDelay();
  sclLow();
  sdaHigh();  // release SDA after ACK/NACK
  halfCycleDelay();

  return data;
}

// Bus recovery: clock out 9 pulses with SDA released.
// If a slave is holding SDA low (e.g. after a mid-transfer reset),
// it will release after receiving enough clocks to finish its byte.
void busRecovery() {
  sdaHigh();
  for (uint8_t i = 0; i < BUS_RECOVERY_CLOCKS; i++) {
    sclHigh();
    halfCycleDelay();
    sclLow();
    halfCycleDelay();
  }
  i2cStop();
}

}  // namespace

void i2cInit() {
  // Start with both lines released (HIGH via pull-ups)
  sdaHigh();
  sclHigh();
  halfCycleDelay();

  // Recover the bus in case a slave is stuck
  busRecovery();
}

bool i2cWriteRegister(uint8_t deviceAddr, uint8_t reg, uint8_t value) {
  i2cStart();
  if (!i2cWriteByte((deviceAddr << 1) | I2C_WRITE_BIT)) {
    i2cStop();
    return false;
  }
  if (!i2cWriteByte(reg)) {
    i2cStop();
    return false;
  }
  if (!i2cWriteByte(value)) {
    i2cStop();
    return false;
  }
  i2cStop();
  return true;
}

bool i2cReadBytes(uint8_t deviceAddr, uint8_t startReg, uint8_t *buffer, uint8_t length) {
  // Phase 1: Write the register address (repeated start)
  i2cStart();
  if (!i2cWriteByte((deviceAddr << 1) | I2C_WRITE_BIT)) {
    i2cStop();
    return false;
  }
  if (!i2cWriteByte(startReg)) {
    i2cStop();
    return false;
  }

  // Phase 2: Repeated START, then read `length` bytes
  i2cStart();
  if (!i2cWriteByte((deviceAddr << 1) | I2C_READ_BIT)) {
    i2cStop();
    return false;
  }

  for (uint8_t i = 0; i < length; i++) {
    const bool isLastByte = (i == length - 1);
    buffer[i] = i2cReadByte(!isLastByte);  // ACK all except last byte
  }

  i2cStop();
  return true;
}

bool i2cProbeAddress(uint8_t address) {
  i2cStart();
  const bool ack = i2cWriteByte((address << 1) | I2C_WRITE_BIT);
  i2cStop();
  return ack;
}

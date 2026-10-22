// MPU6050 driver over the bit-banged bus: probes both possible addresses, wakes
// the sensor, reads the 14-byte accel/temp/gyro burst, and converts acceleration
// into a |g| magnitude.
#include "mpu6050.hpp"

#include <math.h>

#include "app_config.hpp"
#include "i2c_bitbang.hpp"

namespace {

uint8_t gMpuAddress = MPU6050_DEFAULT_ADDRESS;
bool gMpuReady = false;

// MPU6050 register map (only the registers we use)
constexpr uint8_t REG_ACCEL_XOUT_H = 0x3B;
constexpr uint8_t REG_PWR_MGMT_1   = 0x6B;
constexpr uint8_t REG_WHO_AM_I     = 0x75;

// Expected WHO_AM_I value for genuine MPU6050
constexpr uint8_t EXPECTED_WHO_AM_I = 0x68;

// PWR_MGMT_1 value to wake the sensor (clear SLEEP bit)
constexpr uint8_t PWR_MGMT_WAKE = 0x00;

// Burst read length: 3×accel + temp + 3×gyro = 14 bytes
constexpr uint8_t SENSOR_DATA_LENGTH = 14;

// Temperature conversion constants from the MPU6050 datasheet
constexpr float TEMP_SENSITIVITY = 340.0f;
constexpr float TEMP_OFFSET_C    = 36.53f;

bool detectMpuAddress(uint8_t &address) {
  constexpr uint8_t candidates[] = {MPU6050_DEFAULT_ADDRESS, MPU6050_ALT_ADDRESS};
  for (uint8_t i = 0; i < sizeof(candidates); i++) {
    if (i2cProbeAddress(candidates[i])) {
      address = candidates[i];
      return true;
    }
  }
  return false;
}

}  // namespace

bool initMpu6050() {
  if (!detectMpuAddress(gMpuAddress)) {
    Serial.println("No I2C device found at 0x68 or 0x69.");
    Serial.println("Check wiring: SDA=20, SCL=21, GND common, and module power.");
    gMpuReady = false;
    return false;
  }

  Serial.print("MPU candidate found at 0x");
  Serial.println(gMpuAddress, HEX);

  uint8_t whoAmI = 0;
  if (!i2cReadBytes(gMpuAddress, REG_WHO_AM_I, &whoAmI, 1)) {
    Serial.println("WHO_AM_I read failed.");
    gMpuReady = false;
    return false;
  }

  Serial.print("WHO_AM_I = 0x");
  Serial.println(whoAmI, HEX);

  if (whoAmI != EXPECTED_WHO_AM_I) {
    Serial.println("Unexpected WHO_AM_I value.");
  }

  if (!i2cWriteRegister(gMpuAddress, REG_PWR_MGMT_1, PWR_MGMT_WAKE)) {
    Serial.println("Failed to wake MPU6050.");
    gMpuReady = false;
    return false;
  }

  Serial.println("MPU6050 awake. Streaming raw accel/gyro/temp...");
  gMpuReady = true;
  return true;
}

bool isMpuReady() {
  return gMpuReady;
}

bool readMpuRaw(MpuRawData &data) {
  uint8_t raw[SENSOR_DATA_LENGTH];
  if (!i2cReadBytes(gMpuAddress, REG_ACCEL_XOUT_H, raw, SENSOR_DATA_LENGTH)) {
    return false;
  }

  data.ax   = static_cast<int16_t>((raw[0]  << 8) | raw[1]);
  data.ay   = static_cast<int16_t>((raw[2]  << 8) | raw[3]);
  data.az   = static_cast<int16_t>((raw[4]  << 8) | raw[5]);
  data.temp = static_cast<int16_t>((raw[6]  << 8) | raw[7]);
  data.gx   = static_cast<int16_t>((raw[8]  << 8) | raw[9]);
  data.gy   = static_cast<int16_t>((raw[10] << 8) | raw[11]);
  data.gz   = static_cast<int16_t>((raw[12] << 8) | raw[13]);
  return true;
}

float computeAccelMagnitudeG(const MpuRawData &data) {
  const float ax = static_cast<float>(data.ax);
  const float ay = static_cast<float>(data.ay);
  const float az = static_cast<float>(data.az);
  return sqrtf(ax * ax + ay * ay + az * az) / MPU_ACCEL_LSB_PER_G;
}

float rawTempToC(int16_t rawTemp) {
  return static_cast<float>(rawTemp) / TEMP_SENSITIVITY + TEMP_OFFSET_C;
}

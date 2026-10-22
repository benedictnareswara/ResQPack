// Accumulates Serial1 bytes into a line buffer and parses $GPRMC/$GNRMC only,
// holding the latest valid fix for other modules to query.
#include "gps_parser.hpp"

#include <stdlib.h>
#include <string.h>

#include "app_config.hpp"

namespace {

constexpr size_t GPS_LINE_BUFFER_SIZE = 100;
constexpr uint8_t MIN_RMC_TOKEN_COUNT = 7;
constexpr uint8_t MAX_RMC_TOKENS = 16;

char gGpsLine[GPS_LINE_BUFFER_SIZE];
size_t gGpsLinePos = 0;
GpsFix gLatestFix = {false, 0.0f, 0.0f, 0};

bool parseNmeaCoordinate(const char *coord, char hemi, float &outDegrees) {
  if (coord == nullptr || coord[0] == '\0') {
    return false;
  }

  const float raw = static_cast<float>(atof(coord));
  if (raw <= 0.0f) {
    return false;
  }

  const int wholeDegrees = static_cast<int>(raw / 100.0f);
  const float minutes = raw - static_cast<float>(wholeDegrees * 100);
  float decimal = static_cast<float>(wholeDegrees) + (minutes / 60.0f);

  if (hemi == 'S' || hemi == 'W') {
    decimal = -decimal;
  }

  outDegrees = decimal;
  return true;
}

bool parseRmcLine(char *line, GpsFix &fix) {
  if (strncmp(line, "$GPRMC", 6) != 0 && strncmp(line, "$GNRMC", 6) != 0) {
    return false;
  }

  char *tokens[MAX_RMC_TOKENS] = {nullptr};
  uint8_t count = 0;

  char *cursor = line;
  while (count < MAX_RMC_TOKENS) {
    tokens[count++] = cursor;
    char *comma = strchr(cursor, ',');
    if (comma == nullptr) {
      break;
    }
    *comma = '\0';
    cursor = comma + 1;
  }

  if (count < MIN_RMC_TOKEN_COUNT) {
    return false;
  }

  const char *status = tokens[2];
  if (status == nullptr || status[0] != 'A') {
    return false;
  }

  const char *latHem = tokens[4];
  const char *lonHem = tokens[6];
  if (latHem == nullptr || lonHem == nullptr || latHem[0] == '\0' || lonHem[0] == '\0') {
    return false;
  }

  float lat = 0.0f;
  float lon = 0.0f;
  if (!parseNmeaCoordinate(tokens[3], latHem[0], lat)) {
    return false;
  }
  if (!parseNmeaCoordinate(tokens[5], lonHem[0], lon)) {
    return false;
  }

  fix.valid = true;
  fix.latitude = lat;
  fix.longitude = lon;
  fix.updatedMs = millis();
  return true;
}

}  // namespace

void processGpsStream() {
  while (Serial1.available() > 0) {
    const char c = static_cast<char>(Serial1.read());

    if (c == '\r') {
      continue;
    }

    if (c == '$') {
      gGpsLinePos = 0;
      gGpsLine[gGpsLinePos++] = c;
      continue;
    }

    if (c == '\n') {
      gGpsLine[gGpsLinePos] = '\0';
      if (gGpsLinePos > 6) {
        GpsFix parsed = {false, 0.0f, 0.0f, 0};
        if (parseRmcLine(gGpsLine, parsed)) {
          gLatestFix = parsed;
        }
      }
      gGpsLinePos = 0;
      continue;
    }

    if (gGpsLinePos < sizeof(gGpsLine) - 1) {
      gGpsLine[gGpsLinePos++] = c;
    } else {
      gGpsLinePos = 0;
    }
  }
}

bool hasFreshFix() {
  return gLatestFix.valid && (millis() - gLatestFix.updatedMs <= GPS_FIX_STALE_MS);
}

const GpsFix &getLatestFix() {
  return gLatestFix;
}

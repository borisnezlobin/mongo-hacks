#pragma once

#include "esp_err.h"

/* Reads the die temperature once a second and hands it to the camera duty
 * cycle. The board reaches 80-95 C with the camera running, which is past the
 * ESP32-S3R8's +65 C ambient rating and well past a burn. */
esp_err_t thermal_start(void);

float thermal_die_celsius(void);

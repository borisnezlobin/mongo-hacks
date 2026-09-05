#pragma once

#include "esp_err.h"

/* The PDM microphone on the Sense expansion board: CLK on GPIO42, DIN on
 * GPIO41. 16 kHz int16 mono, read in 30 ms blocks, sent on in the 1,600-sample
 * frames shared/contracts.ts asks for. This is the one thing on the board that
 * never stops. */
esp_err_t pdm_mic_start(void);

float pdm_mic_noise_floor_db(void);

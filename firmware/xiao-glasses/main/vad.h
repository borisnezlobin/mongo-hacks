#pragma once

/* Board-side voice activity detection: energy against an adaptive noise floor,
 * gated by zero-crossing rate so a fan or a door does not wake the camera.
 *
 * Pure C with no ESP-IDF dependency, so ../test_host/vad_test.c compiles it
 * with plain `cc`. */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Energy reported for a frame of digital silence, and the value the noise floor
 * is seeded to before the first frame arrives. */
#define VAD_SILENCE_DB (-100.0f)

/* Speech-shaped zero-crossing rates, per second of audio. Below this is rumble
 * and handling noise; above it is hiss. */
#define VAD_ZCR_MIN_PER_SEC 166
#define VAD_ZCR_MAX_PER_SEC 2000

/* How fast the noise floor tracks the room, applied on non-voice frames only. */
#define VAD_NOISE_FLOOR_ALPHA 0.05f

typedef struct {
    float margin_db;
    float noise_floor_db;
    int frame_ms;
    int hangover_frames;
    int hangover_left;
    int min_zero_crossings;
    int max_zero_crossings;
    bool speaking;
} vad_t;

typedef struct {
    float energy_db;
    int zero_crossings;
    /* This frame on its own looks like voice. */
    bool voiced;
    /* Voice after the hangover is applied; this is what the camera reacts to. */
    bool speaking;
} vad_result_t;

void vad_init(vad_t *vad, float margin_db, int frame_ms, int hangover_ms);

float vad_frame_energy_db(const int16_t *samples, size_t count);

int vad_frame_zero_crossings(const int16_t *samples, size_t count);

void vad_update_noise_floor(vad_t *vad, float energy_db, bool voiced);

bool vad_apply_hangover(vad_t *vad, bool voiced);

vad_result_t vad_process(vad_t *vad, const int16_t *samples, size_t count);

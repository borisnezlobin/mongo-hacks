/* Host test for the board's VAD. The firmware itself needs a toolchain and a
 * board; this one file does not:
 *
 *   cc -o /tmp/vad_test test_host/vad_test.c main/vad.c && /tmp/vad_test
 */

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "../main/vad.h"

#define SAMPLE_RATE 16000
#define FRAME_MS 30
#define FRAME_SAMPLES ((SAMPLE_RATE * FRAME_MS) / 1000)
#define MARGIN_DB 12.0f
#define HANGOVER_MS 300
#define HANGOVER_FRAMES (HANGOVER_MS / FRAME_MS)

static int failures;

static void check(int condition, const char *what) {
    printf("%s %s\n", condition ? "ok  " : "FAIL", what);
    if (!condition) {
        failures++;
    }
}

static void fill_silence(int16_t *frame) {
    for (int i = 0; i < FRAME_SAMPLES; i++) {
        frame[i] = 0;
    }
}

/* Deterministic room noise: loud enough to move the floor, too broadband to
 * pass the zero-crossing gate. */
static void fill_room_noise(int16_t *frame, uint32_t *seed) {
    for (int i = 0; i < FRAME_SAMPLES; i++) {
        *seed    = (*seed * 1664525u) + 1013904223u;
        frame[i] = (int16_t)((int32_t)((*seed >> 16) & 0x3ff) - 512);
    }
}

static void fill_tone(int16_t *frame, double hz, double amplitude, double *phase) {
    const double step = 2.0 * M_PI * hz / (double)SAMPLE_RATE;
    for (int i = 0; i < FRAME_SAMPLES; i++) {
        frame[i] = (int16_t)(amplitude * sin(*phase));
        *phase += step;
    }
}

static void feed(vad_t *vad, int16_t *frame, int frames, void (*fill)(int16_t *), bool *any_speech) {
    for (int i = 0; i < frames; i++) {
        fill(frame);
        vad_result_t result = vad_process(vad, frame, FRAME_SAMPLES);
        if (result.speaking) {
            *any_speech = true;
        }
    }
}

static void test_silence_never_trips(void) {
    vad_t vad;
    vad_init(&vad, MARGIN_DB, FRAME_MS, HANGOVER_MS);

    int16_t frame[FRAME_SAMPLES];
    bool any_speech = false;
    feed(&vad, frame, 200, fill_silence, &any_speech);

    check(!any_speech, "digital silence never reports speech");
}

static void settle_noise_floor(vad_t *vad, int16_t *frame, uint32_t *seed) {
    for (int i = 0; i < 300; i++) {
        fill_room_noise(frame, seed);
        vad_process(vad, frame, FRAME_SAMPLES);
    }
}

static void test_room_noise_never_trips(void) {
    vad_t vad;
    vad_init(&vad, MARGIN_DB, FRAME_MS, HANGOVER_MS);

    int16_t frame[FRAME_SAMPLES];
    uint32_t seed   = 7;
    bool any_speech = false;
    for (int i = 0; i < 300; i++) {
        fill_room_noise(frame, &seed);
        if (vad_process(&vad, frame, FRAME_SAMPLES).speaking) {
            any_speech = true;
        }
    }

    check(!any_speech, "broadband room noise never reports speech");
    check(vad.noise_floor_db > VAD_SILENCE_DB + 20.0f,
          "the noise floor climbs to meet the room");
}

static void test_tone_above_the_margin_trips(void) {
    vad_t vad;
    vad_init(&vad, MARGIN_DB, FRAME_MS, HANGOVER_MS);

    int16_t frame[FRAME_SAMPLES];
    uint32_t seed = 11;
    settle_noise_floor(&vad, frame, &seed);

    const float floor_db = vad.noise_floor_db;
    double phase         = 0.0;
    fill_tone(frame, 200.0, 8000.0, &phase);
    vad_result_t result = vad_process(&vad, frame, FRAME_SAMPLES);

    check(result.energy_db > floor_db + MARGIN_DB,
          "a 200 Hz tone lands well above the floor plus the margin");
    check(result.voiced, "a speech-shaped tone above the margin is voiced");
    check(result.zero_crossings >= vad.min_zero_crossings &&
              result.zero_crossings <= vad.max_zero_crossings,
          "a 200 Hz tone crosses zero at a speech-shaped rate");
}

static void test_hangover_holds_for_ten_frames(void) {
    vad_t vad;
    vad_init(&vad, MARGIN_DB, FRAME_MS, HANGOVER_MS);

    int16_t frame[FRAME_SAMPLES];
    uint32_t seed = 13;
    settle_noise_floor(&vad, frame, &seed);

    double phase = 0.0;
    for (int i = 0; i < 5; i++) {
        fill_tone(frame, 200.0, 8000.0, &phase);
        vad_process(&vad, frame, FRAME_SAMPLES);
    }

    int held = 0;
    for (int i = 0; i < HANGOVER_FRAMES * 3; i++) {
        fill_silence(frame);
        if (!vad_process(&vad, frame, FRAME_SAMPLES).speaking) {
            break;
        }
        held++;
    }

    check(held == HANGOVER_FRAMES, "speech holds for exactly 300 ms of hangover");
}

int main(void) {
    test_silence_never_trips();
    test_room_noise_never_trips();
    test_tone_above_the_margin_trips();
    test_hangover_holds_for_ten_frames();

    if (failures > 0) {
        printf("\n%d check(s) failed\n", failures);
        return 1;
    }
    printf("\nall checks passed\n");
    return 0;
}

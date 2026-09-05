#include "vad.h"

#include <math.h>

#define VAD_FULL_SCALE 32768.0f

static int zero_crossings_for(int frame_ms, int per_second) {
    return (per_second * frame_ms) / 1000;
}

void vad_init(vad_t *vad, float margin_db, int frame_ms, int hangover_ms) {
    vad->margin_db          = margin_db;
    vad->noise_floor_db     = VAD_SILENCE_DB;
    vad->frame_ms           = frame_ms;
    vad->hangover_frames    = (hangover_ms + frame_ms - 1) / frame_ms;
    vad->hangover_left      = 0;
    vad->min_zero_crossings = zero_crossings_for(frame_ms, VAD_ZCR_MIN_PER_SEC);
    vad->max_zero_crossings = zero_crossings_for(frame_ms, VAD_ZCR_MAX_PER_SEC);
    vad->speaking           = false;
}

float vad_frame_energy_db(const int16_t *samples, size_t count) {
    if (count == 0) {
        return VAD_SILENCE_DB;
    }

    double sum_of_squares = 0.0;
    for (size_t i = 0; i < count; i++) {
        const double sample = (double)samples[i];
        sum_of_squares += sample * sample;
    }

    const float rms = (float)sqrt(sum_of_squares / (double)count) / VAD_FULL_SCALE;
    if (rms <= 0.0f) {
        return VAD_SILENCE_DB;
    }

    const float db = 20.0f * log10f(rms);
    return db < VAD_SILENCE_DB ? VAD_SILENCE_DB : db;
}

int vad_frame_zero_crossings(const int16_t *samples, size_t count) {
    int crossings = 0;
    for (size_t i = 1; i < count; i++) {
        if ((samples[i - 1] < 0) != (samples[i] < 0)) {
            crossings++;
        }
    }
    return crossings;
}

void vad_update_noise_floor(vad_t *vad, float energy_db, bool voiced) {
    if (voiced) {
        return;
    }
    vad->noise_floor_db +=
        VAD_NOISE_FLOOR_ALPHA * (energy_db - vad->noise_floor_db);
    if (vad->noise_floor_db < VAD_SILENCE_DB) {
        vad->noise_floor_db = VAD_SILENCE_DB;
    }
}

bool vad_apply_hangover(vad_t *vad, bool voiced) {
    if (voiced) {
        vad->hangover_left = vad->hangover_frames;
        vad->speaking      = true;
        return true;
    }
    if (vad->hangover_left > 0) {
        vad->hangover_left--;
        vad->speaking = true;
        return true;
    }
    vad->speaking = false;
    return false;
}

static bool looks_like_voice(const vad_t *vad, float energy_db, int zero_crossings) {
    const bool loud_enough = energy_db > vad->noise_floor_db + vad->margin_db;
    const bool speech_shaped =
        zero_crossings >= vad->min_zero_crossings && zero_crossings <= vad->max_zero_crossings;
    return loud_enough && speech_shaped;
}

vad_result_t vad_process(vad_t *vad, const int16_t *samples, size_t count) {
    vad_result_t result;
    result.energy_db      = vad_frame_energy_db(samples, count);
    result.zero_crossings = vad_frame_zero_crossings(samples, count);
    result.voiced         = looks_like_voice(vad, result.energy_db, result.zero_crossings);
    result.speaking       = vad_apply_hangover(vad, result.voiced);
    vad_update_noise_floor(vad, result.energy_db, result.voiced);
    return result;
}

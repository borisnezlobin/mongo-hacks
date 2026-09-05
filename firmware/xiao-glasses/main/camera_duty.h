#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/* The camera's whole life. It is off unless voice, the phone, or the idle poll
 * asks for a frame, and it is off regardless once the die gets too hot. Audio
 * is never gated by any of this. */
typedef enum {
    CAMERA_DUTY_IDLE,
    CAMERA_DUTY_BURST,
    CAMERA_DUTY_THERMAL_HALT,
} camera_duty_state_t;

esp_err_t camera_duty_start(void);

void camera_duty_on_vad(bool speaking);

void camera_duty_request_burst(uint32_t duration_ms);

void camera_duty_on_temperature(float celsius);

void camera_duty_on_client(bool connected);

void camera_duty_set_burst_fps(int fps);

void camera_duty_set_idle_poll_ms(int interval_ms);

camera_duty_state_t camera_duty_state(void);

const char *camera_duty_state_name(void);

/* Frames actually sent over the last second. */
float camera_duty_fps(void);

bool camera_duty_speaking(void);

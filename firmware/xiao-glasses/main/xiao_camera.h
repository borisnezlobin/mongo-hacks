#pragma once

#include <stdbool.h>

#include "esp_camera.h"
#include "esp_err.h"

/* Brings the camera up once to identify the sensor, then leaves it asleep: the
 * XIAO has no PWDN line, so "off" means the sensor standby bit, a freed frame
 * buffer, and a stopped XCLK. */
esp_err_t xiao_camera_start(void);

/* Idempotent. Costs a camera init (roughly 300 ms) on a cold start. */
esp_err_t xiao_camera_wake(void);

void xiao_camera_sleep(void);

bool xiao_camera_is_awake(void);

/* The frame size burst and idle-poll captures use. VGA by default. */
esp_err_t xiao_camera_set_burst_framesize(framesize_t framesize);

/* Paired: every non-NULL frame from xiao_camera_frame_get must go back through
 * xiao_camera_frame_return. */
camera_fb_t *xiao_camera_frame_get(void);

void xiao_camera_frame_return(camera_fb_t *fb);

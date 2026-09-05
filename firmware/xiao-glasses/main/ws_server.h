#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

/* The wire protocol is defined in shared/contracts.ts. Header, little-endian:
 *
 *   [u8 kind][u8 flags][u16 seq][u32 ts_ms]
 *
 * and JPEG frames add [u16 width][u16 height]. Audio payloads are exactly
 * GLASSES_AUDIO_FRAME_SAMPLES int16 samples so one board frame becomes one
 * /stream frame on the phone. */
#define GLASSES_FRAME_AUDIO 0x01
#define GLASSES_FRAME_JPEG 0x02
#define GLASSES_HEADER_BYTES 8
#define GLASSES_JPEG_HEADER_BYTES 12
#define GLASSES_AUDIO_FRAME_SAMPLES 1600
#define GLASSES_SAMPLE_RATE 16000
#define GLASSES_PROTOCOL_VERSION 1

esp_err_t ws_server_start(void);

bool ws_server_has_client(void);

void ws_server_send_audio(const int16_t *samples, size_t count, uint32_t ts_ms);

void ws_server_send_jpeg(const uint8_t *jpeg, size_t length, uint16_t width, uint16_t height,
                         uint32_t ts_ms);

/* Takes a NUL-terminated JSON document and copies it; the caller keeps its
 * buffer. */
void ws_server_send_text(const char *json);

uint32_t ws_server_audio_drops(void);

uint32_t ws_server_frame_drops(void);

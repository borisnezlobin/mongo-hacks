#include "pdm_mic.h"

#include <string.h>

#include "camera_duty.h"
#include "driver/i2s_pdm.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "glasses_time.h"
#include "sdkconfig.h"
#include "vad.h"
#include "ws_server.h"

static const char *TAG = "pdm_mic";

#define PDM_MIC_CLK_GPIO 42
#define PDM_MIC_DIN_GPIO 41

#define PDM_MIC_READ_MS 30
#define PDM_MIC_READ_SAMPLES ((GLASSES_SAMPLE_RATE * PDM_MIC_READ_MS) / 1000)
#define PDM_MIC_SPEECH_HANGOVER_MS 300

/* Core 1 is left to the microphone. Wi-Fi, the HTTP server, the camera and the
 * thermal task all sit on core 0, so nothing there can stall a read. */
#define PDM_MIC_TASK_STACK_BYTES 4096
#define PDM_MIC_TASK_PRIORITY 5
#define PDM_MIC_TASK_CORE 1

static i2s_chan_handle_t s_rx_channel;
static vad_t s_vad;

/* One frame under construction plus the block just read off the bus. */
static int16_t s_frame[GLASSES_AUDIO_FRAME_SAMPLES];
static int16_t s_block[PDM_MIC_READ_SAMPLES];
static size_t s_frame_fill;
static uint32_t s_base_ms;
static uint64_t s_frames_emitted;

float pdm_mic_noise_floor_db(void) { return s_vad.noise_floor_db; }

static esp_err_t open_pdm_channel(void) {
    i2s_chan_config_t channel_config = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    channel_config.auto_clear        = true;
    esp_err_t err = i2s_new_channel(&channel_config, NULL, &s_rx_channel);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_new_channel failed: %s", esp_err_to_name(err));
        return err;
    }

    i2s_pdm_rx_config_t pdm_config = {
        .clk_cfg  = I2S_PDM_RX_CLK_DEFAULT_CONFIG(GLASSES_SAMPLE_RATE),
        .slot_cfg = I2S_PDM_RX_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg =
            {
                .clk          = PDM_MIC_CLK_GPIO,
                .din          = PDM_MIC_DIN_GPIO,
                .invert_flags = {.clk_inv = false},
            },
    };

    err = i2s_channel_init_pdm_rx_mode(s_rx_channel, &pdm_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_channel_init_pdm_rx_mode failed: %s", esp_err_to_name(err));
        return err;
    }
    return i2s_channel_enable(s_rx_channel);
}

/* Derived from the sample count rather than the wall clock, so the phone can
 * lay frames end to end without the board's scheduling jitter leaking in. */
static uint32_t timestamp_for_next_frame(void) {
    const uint64_t elapsed_ms =
        (s_frames_emitted * GLASSES_AUDIO_FRAME_SAMPLES * 1000ull) / GLASSES_SAMPLE_RATE;
    return s_base_ms + (uint32_t)elapsed_ms;
}

static void emit_full_frames(void) {
    while (s_frame_fill >= GLASSES_AUDIO_FRAME_SAMPLES) {
        ws_server_send_audio(s_frame, GLASSES_AUDIO_FRAME_SAMPLES, timestamp_for_next_frame());
        s_frames_emitted++;
        s_frame_fill = 0;
    }
}

static void append_block(const int16_t *samples, size_t count) {
    memcpy(s_frame + s_frame_fill, samples, count * sizeof(int16_t));
    s_frame_fill += count;
    emit_full_frames();
}

/* A 30 ms block never spans more than one frame boundary, because 1,600 is not
 * a multiple of 480; the split is done here rather than in a ring buffer. */
static void buffer_block(const int16_t *samples, size_t count) {
    const size_t room = GLASSES_AUDIO_FRAME_SAMPLES - s_frame_fill;
    if (count <= room) {
        append_block(samples, count);
        return;
    }
    append_block(samples, room);
    append_block(samples + room, count - room);
}

static void pdm_mic_task(void *unused_arg) {
    (void)unused_arg;
    s_base_ms = glasses_now_ms();

    for (;;) {
        size_t bytes_read = 0;
        esp_err_t err     = i2s_channel_read(s_rx_channel, s_block, sizeof(s_block), &bytes_read,
                                             portMAX_DELAY);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "i2s_channel_read failed: %s", esp_err_to_name(err));
            continue;
        }

        const size_t count = bytes_read / sizeof(int16_t);
        camera_duty_on_vad(vad_process(&s_vad, s_block, count).speaking);
        buffer_block(s_block, count);
    }
}

esp_err_t pdm_mic_start(void) {
    vad_init(&s_vad, (float)CONFIG_GLASSES_VAD_MARGIN_DB, PDM_MIC_READ_MS,
             PDM_MIC_SPEECH_HANGOVER_MS);

    esp_err_t err = open_pdm_channel();
    if (err != ESP_OK) {
        return err;
    }

    if (xTaskCreatePinnedToCore(pdm_mic_task, "pdm_mic", PDM_MIC_TASK_STACK_BYTES, NULL,
                                PDM_MIC_TASK_PRIORITY, NULL, PDM_MIC_TASK_CORE) != pdPASS) {
        ESP_LOGE(TAG, "could not create the microphone task");
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "PDM mic running: CLK GPIO%d, DIN GPIO%d, %d Hz mono, %d ms reads",
             PDM_MIC_CLK_GPIO, PDM_MIC_DIN_GPIO, GLASSES_SAMPLE_RATE, PDM_MIC_READ_MS);
    return ESP_OK;
}

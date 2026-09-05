#include "status.h"

#include <stdio.h>

#include "camera_duty.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "glasses_time.h"
#include "thermal.h"
#include "wifi_softap.h"
#include "ws_server.h"

static const char *TAG = "status";

#define STATUS_TASK_STACK_BYTES 3072
#define STATUS_TASK_PRIORITY 2
#define STATUS_TASK_CORE 0
#define STATUS_PERIOD_MS 1000
#define STATUS_JSON_BYTES 320

static void write_status_json(char *out, size_t capacity) {
    int8_t rssi           = 0;
    const bool have_rssi  = glasses_wifi_station_rssi(&rssi);
    const int written     = snprintf(
        out, capacity,
        "{\"type\":\"status\",\"ts_ms\":%u,\"die_c\":%.1f,\"camera\":\"%s\",\"vad\":%s,"
        "\"fps\":%.1f,\"audio_drops\":%u,\"frame_drops\":%u,\"heap_free\":%u,\"psram_free\":%u",
        (unsigned)glasses_now_ms(), thermal_die_celsius(), camera_duty_state_name(),
        camera_duty_speaking() ? "true" : "false", camera_duty_fps(),
        (unsigned)ws_server_audio_drops(), (unsigned)ws_server_frame_drops(),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));

    if (written < 0 || (size_t)written >= capacity) {
        return;
    }
    if (have_rssi) {
        snprintf(out + written, capacity - (size_t)written, ",\"rssi\":%d}", rssi);
        return;
    }
    snprintf(out + written, capacity - (size_t)written, "}");
}

void status_send_now(void) {
    char json[STATUS_JSON_BYTES];
    write_status_json(json, sizeof(json));
    ws_server_send_text(json);
}

static void status_task(void *unused_arg) {
    (void)unused_arg;
    for (;;) {
        status_send_now();
        vTaskDelay(pdMS_TO_TICKS(STATUS_PERIOD_MS));
    }
}

esp_err_t status_start(void) {
    if (xTaskCreatePinnedToCore(status_task, "status", STATUS_TASK_STACK_BYTES, NULL,
                                STATUS_TASK_PRIORITY, NULL, STATUS_TASK_CORE) != pdPASS) {
        ESP_LOGE(TAG, "could not create the status task");
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

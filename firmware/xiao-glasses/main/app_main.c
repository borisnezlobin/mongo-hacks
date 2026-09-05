#include "camera_duty.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "pdm_mic.h"
#include "sdkconfig.h"
#include "status.h"
#include "thermal.h"
#include "wifi_softap.h"
#include "ws_server.h"
#include "xiao_camera.h"

static const char *TAG = "xiao_glasses";

/* Wi-Fi keeps its calibration data in NVS, and a version bump on an already
 * flashed board leaves a partition the current IDF cannot read. */
static esp_err_t nvs_start(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    return err;
}

void app_main(void) {
    ESP_LOGI(TAG, "Amelia glasses starting: softAP \"%s\", WebSocket on port %d",
             CONFIG_GLASSES_AP_SSID, CONFIG_GLASSES_WS_PORT);

    ESP_ERROR_CHECK(nvs_start());
    ESP_ERROR_CHECK(glasses_wifi_start());
    ESP_ERROR_CHECK(xiao_camera_start());
    ESP_ERROR_CHECK(thermal_start());
    ESP_ERROR_CHECK(ws_server_start());
    ESP_ERROR_CHECK(camera_duty_start());
    ESP_ERROR_CHECK(status_start());
    ESP_ERROR_CHECK(pdm_mic_start());

    ESP_LOGI(TAG, "up: camera idle, microphone running, waiting for a client on /ws");
}

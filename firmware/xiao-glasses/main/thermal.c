#include "thermal.h"

#include "camera_duty.h"
#include "driver/temperature_sensor.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "thermal";

#define THERMAL_TASK_STACK_BYTES 3072
#define THERMAL_TASK_PRIORITY 1
#define THERMAL_TASK_CORE 0
#define THERMAL_PERIOD_MS 1000

static temperature_sensor_handle_t s_sensor;
static volatile float s_die_celsius;

float thermal_die_celsius(void) { return s_die_celsius; }

static void thermal_task(void *unused_arg) {
    (void)unused_arg;
    for (;;) {
        float celsius = 0.0f;
        esp_err_t err = temperature_sensor_get_celsius(s_sensor, &celsius);
        if (err == ESP_OK) {
            s_die_celsius = celsius;
            camera_duty_on_temperature(celsius);
        } else {
            ESP_LOGE(TAG, "temperature_sensor_get_celsius failed: %s", esp_err_to_name(err));
        }
        vTaskDelay(pdMS_TO_TICKS(THERMAL_PERIOD_MS));
    }
}

esp_err_t thermal_start(void) {
    temperature_sensor_config_t config = TEMPERATURE_SENSOR_CONFIG_DEFAULT(20, 100);
    esp_err_t err                      = temperature_sensor_install(&config, &s_sensor);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "temperature_sensor_install failed: %s", esp_err_to_name(err));
        return err;
    }

    err = temperature_sensor_enable(s_sensor);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "temperature_sensor_enable failed: %s", esp_err_to_name(err));
        return err;
    }

    if (xTaskCreatePinnedToCore(thermal_task, "thermal", THERMAL_TASK_STACK_BYTES, NULL,
                                THERMAL_TASK_PRIORITY, NULL, THERMAL_TASK_CORE) != pdPASS) {
        ESP_LOGE(TAG, "could not create the thermal task");
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

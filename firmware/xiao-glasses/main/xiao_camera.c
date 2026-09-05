#include "xiao_camera.h"

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_rom_gpio.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "sdkconfig.h"
#include "sensor.h"
#include "soc/gpio_sig_map.h"

static const char *TAG = "xiao_camera";

#if CONFIG_GLASSES_CAMERA_XCLK_20MHZ
#define XIAO_CAMERA_XCLK_HZ 20000000
#elif CONFIG_GLASSES_CAMERA_XCLK_16MHZ
#define XIAO_CAMERA_XCLK_HZ 16000000
#else
#define XIAO_CAMERA_XCLK_HZ 10000000
#endif

#define XIAO_CAMERA_XCLK_PIN 10

/* Software standby, per sensor. Both registers are private to the camera
 * component, so the constants are repeated here.
 *
 * OV2640 (ov2640_regs.h): select the sensor register bank (0xFF = 0x01), then
 * set bit 4 of COM2 (0x09). ov2640.c's set_reg carries the bank in bit 8 of the
 * register address and does the bank select itself.
 *
 * OV3660 (ov3660_regs.h): SYSTEM_CTROL0 = 0x3008 bit 6, software power down.
 * The driver's own init writes 0x82, 0x42 and finally 0x02 to this register,
 * which is what clears the bit again on the next esp_camera_init(). */
#define OV2640_REG_COM2 0x109
#define OV2640_COM2_STANDBY 0x10
#define OV3660_REG_SYSTEM_CTROL0 0x3008
#define OV3660_SYSTEM_CTROL0_POWER_DOWN 0x40

static camera_config_t s_camera_config = {
    .pin_pwdn     = -1,
    .pin_reset    = -1,
    .pin_xclk     = XIAO_CAMERA_XCLK_PIN,
    .pin_sccb_sda = 40,
    .pin_sccb_scl = 39,
    .pin_d7       = 48,
    .pin_d6       = 11,
    .pin_d5       = 12,
    .pin_d4       = 14,
    .pin_d3       = 16,
    .pin_d2       = 18,
    .pin_d1       = 17,
    .pin_d0       = 15,
    .pin_vsync    = 38,
    .pin_href     = 47,
    .pin_pclk     = 13,
    .xclk_freq_hz = XIAO_CAMERA_XCLK_HZ,
    .ledc_timer   = LEDC_TIMER_0,
    .ledc_channel = LEDC_CHANNEL_0,
    .pixel_format = PIXFORMAT_JPEG,
    .frame_size   = FRAMESIZE_VGA,
    .jpeg_quality = CONFIG_GLASSES_JPEG_QUALITY,
    .fb_count     = 2,
    .fb_location  = CAMERA_FB_IN_PSRAM,
    .grab_mode    = CAMERA_GRAB_LATEST,
};

static SemaphoreHandle_t s_camera_lock;
static volatile bool s_camera_awake;

static void lock_camera(void) { xSemaphoreTake(s_camera_lock, portMAX_DELAY); }

static void unlock_camera(void) { xSemaphoreGive(s_camera_lock); }

static const char *sensor_name(uint16_t pid) {
    switch (pid) {
        case OV2640_PID:
            return "OV2640";
        case OV3660_PID:
            return "OV3660";
        case OV5640_PID:
            return "OV5640";
        default:
            return "unrecognised sensor";
    }
}

static void log_sensor_identity(void) {
    sensor_t *sensor = esp_camera_sensor_get();
    if (sensor == NULL) {
        return;
    }
    ESP_LOGI(TAG, "Detected %s camera (PID 0x%04x), XCLK %d MHz, JPEG quality %d",
             sensor_name(sensor->id.PID), sensor->id.PID, XIAO_CAMERA_XCLK_HZ / 1000000,
             CONFIG_GLASSES_JPEG_QUALITY);
}

static esp_err_t camera_power_up(void) {
    if (s_camera_awake) {
        return ESP_OK;
    }

    const int64_t started_us = esp_timer_get_time();
    esp_err_t err            = esp_camera_init(&s_camera_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_camera_init failed: 0x%x (%s)", err, esp_err_to_name(err));
        return err;
    }
    s_camera_awake = true;
    ESP_LOGD(TAG, "camera awake after %d ms", (int)((esp_timer_get_time() - started_us) / 1000));
    return ESP_OK;
}

/* esp_camera_deinit() tears down the DMA and the sensor state, but on the
 * ESP32-S3 the XCLK comes out of the LCD_CAM module rather than LEDC and its
 * DISABLE_OUT_CLOCK hook is an empty macro, so GPIO10 keeps toggling until the
 * signal is unrouted by hand. Driving it low leaves the sensor with no clock at
 * all and no floating input. esp_camera_init() re-routes the pin on wake. */
static void camera_stop_xclk(void) {
    esp_rom_gpio_connect_out_signal(XIAO_CAMERA_XCLK_PIN, SIG_GPIO_OUT_IDX, false, false);
    gpio_set_direction(XIAO_CAMERA_XCLK_PIN, GPIO_MODE_OUTPUT);
    gpio_set_level(XIAO_CAMERA_XCLK_PIN, 0);
}

static const struct {
    uint16_t pid;
    int reg;
    int bit;
    const char *description;
} SENSOR_STANDBY_REGISTERS[] = {
    {OV2640_PID, OV2640_REG_COM2, OV2640_COM2_STANDBY, "OV2640 COM2 standby bit"},
    {OV3660_PID, OV3660_REG_SYSTEM_CTROL0, OV3660_SYSTEM_CTROL0_POWER_DOWN,
     "OV3660 SYSTEM_CTROL0 software power down"},
};

static void sensor_enter_standby(void) {
    sensor_t *sensor = esp_camera_sensor_get();
    if (sensor == NULL) {
        ESP_LOGW(TAG, "no sensor handle, sleeping with the XCLK stopped only");
        return;
    }

    const size_t count = sizeof(SENSOR_STANDBY_REGISTERS) / sizeof(SENSOR_STANDBY_REGISTERS[0]);
    for (size_t i = 0; i < count; i++) {
        if (SENSOR_STANDBY_REGISTERS[i].pid != sensor->id.PID) {
            continue;
        }
        const int bit = SENSOR_STANDBY_REGISTERS[i].bit;
        if (sensor->set_reg(sensor, SENSOR_STANDBY_REGISTERS[i].reg, bit, bit) < 0) {
            ESP_LOGW(TAG, "SCCB write of the %s failed", SENSOR_STANDBY_REGISTERS[i].description);
        }
        return;
    }

    ESP_LOGW(TAG, "%s has no standby register here, sleeping with the XCLK stopped only",
             sensor_name(sensor->id.PID));
}

static void camera_power_down(void) {
    if (!s_camera_awake) {
        return;
    }

    sensor_enter_standby(); /* while SCCB and XCLK are still alive */
    esp_err_t err = esp_camera_deinit();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "esp_camera_deinit returned %s", esp_err_to_name(err));
    }
    camera_stop_xclk();
    s_camera_awake = false;
    ESP_LOGD(TAG, "camera asleep: sensor in standby, XCLK stopped, frame buffers freed");
}

esp_err_t xiao_camera_start(void) {
    s_camera_lock = xSemaphoreCreateMutex();
    if (s_camera_lock == NULL) {
        ESP_LOGE(TAG, "could not create the camera lock");
        return ESP_ERR_NO_MEM;
    }

    lock_camera();
    esp_err_t err = camera_power_up();
    if (err == ESP_OK) {
        log_sensor_identity();
        camera_power_down();
    }
    unlock_camera();
    return err;
}

esp_err_t xiao_camera_wake(void) {
    lock_camera();
    esp_err_t err = camera_power_up();
    unlock_camera();
    return err;
}

void xiao_camera_sleep(void) {
    lock_camera();
    camera_power_down();
    unlock_camera();
}

bool xiao_camera_is_awake(void) { return s_camera_awake; }

/* Takes effect on the next wake, which is where the frame buffers are sized. */
esp_err_t xiao_camera_set_burst_framesize(framesize_t framesize) {
    lock_camera();
    s_camera_config.frame_size = framesize;
    const bool was_awake       = s_camera_awake;
    if (was_awake) {
        camera_power_down();
    }
    esp_err_t err = was_awake ? camera_power_up() : ESP_OK;
    unlock_camera();
    return err;
}

/* The lock is taken here and released in xiao_camera_frame_return, because the
 * sleep path frees the buffer this frame points into and must not run between
 * the two. A FreeRTOS mutex has to be given back by the task that took it, so
 * both calls belong to the camera duty task. */
camera_fb_t *xiao_camera_frame_get(void) {
    lock_camera();
    if (!s_camera_awake) {
        unlock_camera();
        return NULL;
    }

    camera_fb_t *fb = esp_camera_fb_get();
    if (fb == NULL) {
        unlock_camera();
    }
    return fb;
}

void xiao_camera_frame_return(camera_fb_t *fb) {
    esp_camera_fb_return(fb);
    unlock_camera();
}

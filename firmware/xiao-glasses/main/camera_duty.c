#include "camera_duty.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "glasses_time.h"
#include "sdkconfig.h"
#include "ws_server.h"
#include "xiao_camera.h"

static const char *TAG = "camera_duty";

#define CAMERA_DUTY_TASK_STACK_BYTES 4096
#define CAMERA_DUTY_TASK_PRIORITY 4
#define CAMERA_DUTY_TASK_CORE 0
#define CAMERA_DUTY_TICK_MS 5
#define CAMERA_DUTY_FPS_WINDOW_MS 1000

static struct {
    volatile uint32_t speech_until_ms;
    volatile uint32_t burst_until_ms;
    volatile bool client_connected;
    volatile bool speaking;
    volatile bool thermal_halt;
    volatile int burst_fps;
    volatile int idle_poll_ms;
    uint32_t next_burst_frame_ms;
    uint32_t next_idle_frame_ms;
    uint32_t fps_window_started_ms;
    unsigned frames_in_window;
    float fps;
    camera_duty_state_t state;
} s_duty = {
    .burst_fps    = CONFIG_GLASSES_BURST_FPS,
    .idle_poll_ms = CONFIG_GLASSES_IDLE_POLL_MS,
    .state        = CAMERA_DUTY_IDLE,
};

camera_duty_state_t camera_duty_state(void) { return s_duty.state; }

bool camera_duty_speaking(void) { return s_duty.speaking; }

float camera_duty_fps(void) { return s_duty.fps; }

const char *camera_duty_state_name(void) {
    switch (s_duty.state) {
        case CAMERA_DUTY_BURST:
            return "burst";
        case CAMERA_DUTY_THERMAL_HALT:
            return "thermal_halt";
        default:
            return "idle";
    }
}

void camera_duty_on_vad(bool speaking) {
    s_duty.speaking = speaking;
    if (speaking) {
        s_duty.speech_until_ms = glasses_now_ms() + CONFIG_GLASSES_SPEECH_HANGOVER_MS;
    }
}

void camera_duty_request_burst(uint32_t duration_ms) {
    s_duty.burst_until_ms = glasses_now_ms() + duration_ms;
}

void camera_duty_on_temperature(float celsius) {
    if (!s_duty.thermal_halt && celsius >= CONFIG_GLASSES_THERMAL_HALT_C) {
        ESP_LOGW(TAG, "die %.1f C, halting the camera; audio keeps running", celsius);
        s_duty.thermal_halt = true;
    } else if (s_duty.thermal_halt && celsius < CONFIG_GLASSES_THERMAL_RESUME_C) {
        ESP_LOGI(TAG, "die %.1f C, the camera may run again", celsius);
        s_duty.thermal_halt = false;
    }
}

void camera_duty_on_client(bool connected) { s_duty.client_connected = connected; }

void camera_duty_set_burst_fps(int fps) {
    if (fps >= 1 && fps <= 30) {
        s_duty.burst_fps = fps;
    }
}

void camera_duty_set_idle_poll_ms(int interval_ms) {
    if (interval_ms >= 200) {
        s_duty.idle_poll_ms = interval_ms;
    }
}

static void note_frame_sent(uint32_t now_ms) {
    s_duty.frames_in_window++;
    const uint32_t elapsed = now_ms - s_duty.fps_window_started_ms;
    if (elapsed < CAMERA_DUTY_FPS_WINDOW_MS) {
        return;
    }
    s_duty.fps                   = (float)s_duty.frames_in_window * 1000.0f / (float)elapsed;
    s_duty.frames_in_window      = 0;
    s_duty.fps_window_started_ms = now_ms;
}

static void capture_and_send(uint32_t now_ms) {
    if (xiao_camera_wake() != ESP_OK) {
        return;
    }

    camera_fb_t *frame = xiao_camera_frame_get();
    if (frame == NULL) {
        return;
    }
    ws_server_send_jpeg(frame->buf, frame->len, (uint16_t)frame->width, (uint16_t)frame->height,
                        now_ms);
    xiao_camera_frame_return(frame);
    note_frame_sent(now_ms);
}

/* Signed comparison so the 32-bit millisecond clock wrapping does not strand a
 * deadline 49 days into a session. */
static bool deadline_passed(uint32_t now_ms, uint32_t deadline_ms) {
    return (int32_t)(now_ms - deadline_ms) >= 0;
}

static camera_duty_state_t next_state(uint32_t now_ms) {
    if (s_duty.thermal_halt) {
        return CAMERA_DUTY_THERMAL_HALT;
    }
    /* Nobody is listening, so a frame is pure heat. */
    if (!s_duty.client_connected) {
        return CAMERA_DUTY_IDLE;
    }
    const bool speech_recent = !deadline_passed(now_ms, s_duty.speech_until_ms);
    const bool burst_asked   = !deadline_passed(now_ms, s_duty.burst_until_ms);
    return (speech_recent || burst_asked) ? CAMERA_DUTY_BURST : CAMERA_DUTY_IDLE;
}

static void enter_state(camera_duty_state_t state, uint32_t now_ms) {
    if (state == s_duty.state) {
        return;
    }
    s_duty.state = state;
    ESP_LOGI(TAG, "camera %s", camera_duty_state_name());

    if (state == CAMERA_DUTY_BURST) {
        s_duty.next_burst_frame_ms = now_ms;
        return;
    }
    xiao_camera_sleep();
    s_duty.fps               = 0.0f;
    s_duty.frames_in_window  = 0;
    s_duty.next_idle_frame_ms = now_ms + (uint32_t)s_duty.idle_poll_ms;
}

/* One frame every idle_poll_ms, and the camera goes straight back down. */
static void serve_idle(uint32_t now_ms) {
    if (!s_duty.client_connected || !deadline_passed(now_ms, s_duty.next_idle_frame_ms)) {
        return;
    }
    capture_and_send(now_ms);
    xiao_camera_sleep();
    s_duty.next_idle_frame_ms = glasses_now_ms() + (uint32_t)s_duty.idle_poll_ms;
}

static void serve_burst(uint32_t now_ms) {
    if (!deadline_passed(now_ms, s_duty.next_burst_frame_ms)) {
        return;
    }
    capture_and_send(now_ms);
    s_duty.next_burst_frame_ms = now_ms + (uint32_t)(1000 / s_duty.burst_fps);
}

static void serve_state(uint32_t now_ms) {
    if (s_duty.state == CAMERA_DUTY_BURST) {
        serve_burst(now_ms);
    } else if (s_duty.state == CAMERA_DUTY_IDLE) {
        serve_idle(now_ms);
    }
}

static void camera_duty_task(void *unused_arg) {
    (void)unused_arg;
    for (;;) {
        const uint32_t now_ms = glasses_now_ms();
        enter_state(next_state(now_ms), now_ms);
        serve_state(now_ms);
        vTaskDelay(pdMS_TO_TICKS(CAMERA_DUTY_TICK_MS));
    }
}

esp_err_t camera_duty_start(void) {
    const uint32_t now_ms        = glasses_now_ms();
    s_duty.fps_window_started_ms = now_ms;
    s_duty.next_idle_frame_ms    = now_ms + (uint32_t)s_duty.idle_poll_ms;

    if (xTaskCreatePinnedToCore(camera_duty_task, "camera_duty", CAMERA_DUTY_TASK_STACK_BYTES, NULL,
                                CAMERA_DUTY_TASK_PRIORITY, NULL, CAMERA_DUTY_TASK_CORE) != pdPASS) {
        ESP_LOGE(TAG, "could not create the camera duty task");
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

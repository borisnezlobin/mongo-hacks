#include "ws_server.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "camera_duty.h"
#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "glasses_time.h"
#include "sdkconfig.h"
#include "status.h"

static const char *TAG = "ws_server";

/* Audio is the payload that must not stutter, so its queue is deep enough to
 * ride out two seconds of a busy link. JPEGs are the payload worth throwing
 * away, so theirs holds two frames and drops the older one. */
#define WS_AUDIO_QUEUE_DEPTH 20
#define WS_JPEG_QUEUE_DEPTH 2
#define WS_TEXT_QUEUE_DEPTH 4

#define WS_SENDER_TASK_STACK_BYTES 4096
#define WS_SENDER_TASK_PRIORITY 3
#define WS_SENDER_TASK_CORE 0
#define WS_SENDER_IDLE_DELAY_MS 4

#define WS_CONTROL_MAX_BYTES 512

typedef struct {
    uint8_t *bytes;
    size_t length;
    httpd_ws_type_t type;
} ws_packet_t;

static struct {
    httpd_handle_t server;
    int client_fd;
    QueueHandle_t audio_queue;
    QueueHandle_t jpeg_queue;
    QueueHandle_t text_queue;
    uint16_t audio_seq;
    uint16_t jpeg_seq;
    volatile uint32_t audio_drops;
    volatile uint32_t frame_drops;
} s_ws = {.client_fd = -1};

bool ws_server_has_client(void) { return s_ws.client_fd >= 0; }

uint32_t ws_server_audio_drops(void) { return s_ws.audio_drops; }

uint32_t ws_server_frame_drops(void) { return s_ws.frame_drops; }

static void write_header(uint8_t *out, uint8_t kind, uint16_t seq, uint32_t ts_ms) {
    out[0] = kind;
    out[1] = 0; /* flags: reserved, always zero on this firmware */
    memcpy(out + 2, &seq, sizeof(seq));
    memcpy(out + 4, &ts_ms, sizeof(ts_ms));
}

/* Payloads are staged in PSRAM: a VGA JPEG is far too big to spend internal
 * RAM on, and the sender frees every buffer it takes off a queue. */
static uint8_t *stage_buffer(size_t length) {
    uint8_t *bytes = heap_caps_malloc(length, MALLOC_CAP_SPIRAM);
    return bytes != NULL ? bytes : heap_caps_malloc(length, MALLOC_CAP_DEFAULT);
}

static void enqueue_dropping_oldest(QueueHandle_t queue, ws_packet_t *packet,
                                    volatile uint32_t *drops) {
    if (xQueueSend(queue, packet, 0) == pdTRUE) {
        return;
    }

    ws_packet_t oldest;
    if (xQueueReceive(queue, &oldest, 0) == pdTRUE) {
        free(oldest.bytes);
        (*drops)++;
    }
    if (xQueueSend(queue, packet, 0) != pdTRUE) {
        free(packet->bytes);
        (*drops)++;
    }
}

void ws_server_send_audio(const int16_t *samples, size_t count, uint32_t ts_ms) {
    if (!ws_server_has_client()) {
        return;
    }

    const size_t length = GLASSES_HEADER_BYTES + (count * sizeof(int16_t));
    uint8_t *bytes      = stage_buffer(length);
    if (bytes == NULL) {
        s_ws.audio_drops++;
        return;
    }

    write_header(bytes, GLASSES_FRAME_AUDIO, s_ws.audio_seq++, ts_ms);
    memcpy(bytes + GLASSES_HEADER_BYTES, samples, count * sizeof(int16_t));

    ws_packet_t packet = {.bytes = bytes, .length = length, .type = HTTPD_WS_TYPE_BINARY};
    enqueue_dropping_oldest(s_ws.audio_queue, &packet, &s_ws.audio_drops);
}

void ws_server_send_jpeg(const uint8_t *jpeg, size_t length, uint16_t width, uint16_t height,
                         uint32_t ts_ms) {
    if (!ws_server_has_client()) {
        return;
    }

    const size_t total = GLASSES_JPEG_HEADER_BYTES + length;
    uint8_t *bytes     = stage_buffer(total);
    if (bytes == NULL) {
        s_ws.frame_drops++;
        return;
    }

    write_header(bytes, GLASSES_FRAME_JPEG, s_ws.jpeg_seq++, ts_ms);
    memcpy(bytes + 8, &width, sizeof(width));
    memcpy(bytes + 10, &height, sizeof(height));
    memcpy(bytes + GLASSES_JPEG_HEADER_BYTES, jpeg, length);

    ws_packet_t packet = {.bytes = bytes, .length = total, .type = HTTPD_WS_TYPE_BINARY};
    enqueue_dropping_oldest(s_ws.jpeg_queue, &packet, &s_ws.frame_drops);
}

void ws_server_send_text(const char *json) {
    if (!ws_server_has_client()) {
        return;
    }

    const size_t length = strlen(json);
    uint8_t *bytes      = stage_buffer(length);
    if (bytes == NULL) {
        return;
    }
    memcpy(bytes, json, length);

    ws_packet_t packet = {.bytes = bytes, .length = length, .type = HTTPD_WS_TYPE_TEXT};
    uint32_t ignored   = 0;
    enqueue_dropping_oldest(s_ws.text_queue, &packet, &ignored);
}

static void send_packet(const ws_packet_t *packet) {
    httpd_ws_frame_t frame = {
        .final   = true,
        .type    = packet->type,
        .payload = packet->bytes,
        .len     = packet->length,
    };
    esp_err_t err = httpd_ws_send_frame_async(s_ws.server, s_ws.client_fd, &frame);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "send failed (%s), dropping the client", esp_err_to_name(err));
        httpd_sess_trigger_close(s_ws.server, s_ws.client_fd);
    }
}

static bool drain_one(QueueHandle_t queue) {
    ws_packet_t packet;
    if (xQueueReceive(queue, &packet, 0) != pdTRUE) {
        return false;
    }
    if (ws_server_has_client()) {
        send_packet(&packet);
    }
    free(packet.bytes);
    return true;
}

static void ws_sender_task(void *unused_arg) {
    (void)unused_arg;
    for (;;) {
        bool sent = drain_one(s_ws.text_queue);
        sent |= drain_one(s_ws.audio_queue);
        sent |= drain_one(s_ws.jpeg_queue);
        if (!sent) {
            vTaskDelay(pdMS_TO_TICKS(WS_SENDER_IDLE_DELAY_MS));
        }
    }
}

static void send_hello(void) {
    char hello[192];
    snprintf(hello, sizeof(hello),
             "{\"type\":\"hello\",\"protocol\":%d,\"firmware\":\"xiao-glasses %s\","
             "\"sample_rate\":%d,\"frame_samples\":%d}",
             GLASSES_PROTOCOL_VERSION, esp_app_get_description()->version, GLASSES_SAMPLE_RATE,
             GLASSES_AUDIO_FRAME_SAMPLES);
    ws_server_send_text(hello);
}

static void adopt_client(int fd) {
    const int previous = s_ws.client_fd;
    s_ws.client_fd     = fd;
    if (previous >= 0 && previous != fd) {
        ESP_LOGI(TAG, "second client on fd %d, closing fd %d", fd, previous);
        httpd_sess_trigger_close(s_ws.server, previous);
    }
    ESP_LOGI(TAG, "client connected on fd %d", fd);
    camera_duty_on_client(true);
    send_hello();
}

static void drop_client(int fd) {
    if (s_ws.client_fd != fd) {
        return;
    }
    s_ws.client_fd = -1;
    ESP_LOGI(TAG, "client on fd %d disconnected", fd);
    camera_duty_on_client(false);
}

static void apply_control(const cJSON *control) {
    const cJSON *type = cJSON_GetObjectItemCaseSensitive(control, "type");
    if (!cJSON_IsString(type)) {
        return;
    }

    const cJSON *duration = cJSON_GetObjectItemCaseSensitive(control, "duration_ms");
    const cJSON *fps      = cJSON_GetObjectItemCaseSensitive(control, "fps");
    const cJSON *interval = cJSON_GetObjectItemCaseSensitive(control, "interval_ms");

    if (strcmp(type->valuestring, "burst") == 0 && cJSON_IsNumber(duration)) {
        camera_duty_request_burst((uint32_t)duration->valuedouble);
    } else if (strcmp(type->valuestring, "set_fps") == 0 && cJSON_IsNumber(fps)) {
        camera_duty_set_burst_fps((int)fps->valuedouble);
    } else if (strcmp(type->valuestring, "set_idle_poll_ms") == 0 && cJSON_IsNumber(interval)) {
        camera_duty_set_idle_poll_ms((int)interval->valuedouble);
    } else if (strcmp(type->valuestring, "ping") == 0) {
        status_send_now();
    } else {
        ESP_LOGW(TAG, "ignoring control message \"%s\"", type->valuestring);
    }
}

static void handle_control_text(const char *json) {
    cJSON *control = cJSON_Parse(json);
    if (control == NULL) {
        ESP_LOGW(TAG, "control message was not JSON");
        return;
    }
    apply_control(control);
    cJSON_Delete(control);
}

static esp_err_t receive_control_frame(httpd_req_t *req, httpd_ws_frame_t *frame) {
    esp_err_t err = httpd_ws_recv_frame(req, frame, 0);
    if (err != ESP_OK || frame->len == 0 || frame->len > WS_CONTROL_MAX_BYTES) {
        return err;
    }

    char *text = calloc(1, frame->len + 1);
    if (text == NULL) {
        return ESP_ERR_NO_MEM;
    }
    frame->payload = (uint8_t *)text;
    err            = httpd_ws_recv_frame(req, frame, frame->len);
    if (err == ESP_OK && frame->type == HTTPD_WS_TYPE_TEXT) {
        handle_control_text(text);
    }
    free(text);
    return err;
}

static esp_err_t ws_handler(httpd_req_t *req) {
    if (req->method == HTTP_GET) {
        adopt_client(httpd_req_to_sockfd(req));
        return ESP_OK;
    }

    httpd_ws_frame_t frame;
    memset(&frame, 0, sizeof(frame));
    return receive_control_frame(req, &frame);
}

/* Setting close_fn means the server hands the socket back rather than closing
 * it, so this is where the fd is both forgotten and actually closed. */
static void ws_close_handler(httpd_handle_t server, int fd) {
    (void)server;
    drop_client(fd);
    close(fd);
}

static esp_err_t start_queues(void) {
    s_ws.audio_queue = xQueueCreate(WS_AUDIO_QUEUE_DEPTH, sizeof(ws_packet_t));
    s_ws.jpeg_queue  = xQueueCreate(WS_JPEG_QUEUE_DEPTH, sizeof(ws_packet_t));
    s_ws.text_queue  = xQueueCreate(WS_TEXT_QUEUE_DEPTH, sizeof(ws_packet_t));
    if (s_ws.audio_queue == NULL || s_ws.jpeg_queue == NULL || s_ws.text_queue == NULL) {
        ESP_LOGE(TAG, "could not create the send queues");
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

static const httpd_uri_t WS_URI = {
    .uri          = "/ws",
    .method       = HTTP_GET,
    .handler      = ws_handler,
    .user_ctx     = NULL,
    .is_websocket = true,
};

esp_err_t ws_server_start(void) {
    esp_err_t err = start_queues();
    if (err != ESP_OK) {
        return err;
    }

    httpd_config_t config   = HTTPD_DEFAULT_CONFIG();
    config.server_port      = CONFIG_GLASSES_WS_PORT;
    config.max_open_sockets = 3;
    config.close_fn         = ws_close_handler;
    config.lru_purge_enable = true;
    config.stack_size       = 6144;

    err = httpd_start(&s_ws.server, &config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed: %s", esp_err_to_name(err));
        return err;
    }
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_ws.server, &WS_URI));

    if (xTaskCreatePinnedToCore(ws_sender_task, "ws_sender", WS_SENDER_TASK_STACK_BYTES, NULL,
                                WS_SENDER_TASK_PRIORITY, NULL, WS_SENDER_TASK_CORE) != pdPASS) {
        ESP_LOGE(TAG, "could not create the WebSocket sender task");
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "WebSocket ready at ws://192.168.4.1:%d/ws", CONFIG_GLASSES_WS_PORT);
    return ESP_OK;
}

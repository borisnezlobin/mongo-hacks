#include "wifi_softap.h"

#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "sdkconfig.h"

static const char *TAG = "wifi_softap";

/* One phone, and refusing the second is cheaper than sharing the link. */
#define WIFI_SOFTAP_MAX_STATIONS 1

static void log_station_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    if (id == WIFI_EVENT_AP_STACONNECTED) {
        wifi_event_ap_staconnected_t *event = data;
        ESP_LOGI(TAG, "station joined, aid %d", event->aid);
    } else if (id == WIFI_EVENT_AP_STADISCONNECTED) {
        wifi_event_ap_stadisconnected_t *event = data;
        ESP_LOGI(TAG, "station left, aid %d", event->aid);
    }
}

static void fill_ap_config(wifi_config_t *config) {
    memset(config, 0, sizeof(*config));
    const char *ssid     = CONFIG_GLASSES_AP_SSID;
    const char *password = CONFIG_GLASSES_AP_PASSWORD;

    strlcpy((char *)config->ap.ssid, ssid, sizeof(config->ap.ssid));
    strlcpy((char *)config->ap.password, password, sizeof(config->ap.password));
    config->ap.ssid_len       = strlen(ssid);
    config->ap.channel        = CONFIG_GLASSES_AP_CHANNEL;
    config->ap.max_connection = WIFI_SOFTAP_MAX_STATIONS;
    config->ap.authmode       = WIFI_AUTH_WPA2_PSK;
    config->ap.pmf_cfg.required = false;
}

esp_err_t glasses_wifi_start(void) {
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_ap();

    wifi_init_config_t init_config = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init_config));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                        log_station_event, NULL, NULL));

    wifi_config_t ap_config;
    fill_ap_config(&ap_config);
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap_config));
    ESP_ERROR_CHECK(esp_wifi_start());

    /* Modem sleep between beacons. The board is on a face, not a bench. */
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_MIN_MODEM));

    ESP_LOGI(TAG, "softAP \"%s\" up on channel %d, one station, 192.168.4.1",
             CONFIG_GLASSES_AP_SSID, CONFIG_GLASSES_AP_CHANNEL);
    return ESP_OK;
}

bool glasses_wifi_station_rssi(int8_t *out_rssi) {
    wifi_sta_list_t stations;
    if (esp_wifi_ap_get_sta_list(&stations) != ESP_OK || stations.num == 0) {
        return false;
    }
    *out_rssi = stations.sta[0].rssi;
    return true;
}

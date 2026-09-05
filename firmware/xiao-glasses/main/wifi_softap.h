#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/* WPA2-PSK softAP, one station, fixed channel, modem sleep on. The phone joins
 * it; the board never associates to anything. */
/* Named glasses_* rather than wifi_softap_*: the closed-source net80211 blob
 * already exports a wifi_softap_start and the linker will not take a second. */
esp_err_t glasses_wifi_start(void);

bool glasses_wifi_station_rssi(int8_t *out_rssi);

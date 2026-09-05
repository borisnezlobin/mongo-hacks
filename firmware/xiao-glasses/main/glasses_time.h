#pragma once

#include <stdint.h>

#include "esp_timer.h"

/* The one clock every frame timestamp and every deadline in this firmware uses:
 * milliseconds since boot, matching ts_ms in shared/contracts.ts. */
static inline uint32_t glasses_now_ms(void) {
    return (uint32_t)(esp_timer_get_time() / 1000);
}

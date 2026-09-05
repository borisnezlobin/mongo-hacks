#pragma once

#include "esp_err.h"

/* One GlassesStatus JSON frame a second, whether or not anything is happening.
 * Shape and field names come from shared/contracts.ts. */
esp_err_t status_start(void);

/* Answers a control ping without waiting for the next tick. */
void status_send_now(void);

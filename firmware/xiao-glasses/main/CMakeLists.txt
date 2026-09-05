idf_component_register(
    SRCS "app_main.c"
         "wifi_softap.c"
         "xiao_camera.c"
         "pdm_mic.c"
         "vad.c"
         "camera_duty.c"
         "thermal.c"
         "ws_server.c"
         "status.c"
    INCLUDE_DIRS "."
    REQUIRES esp_driver_gpio esp_driver_i2s esp_http_server esp_wifi json
    PRIV_REQUIRES esp_app_format esp_driver_tsens esp_psram esp_timer nvs_flash)

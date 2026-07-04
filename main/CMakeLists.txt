set(WEB_ASSETS
    "${CMAKE_CURRENT_SOURCE_DIR}/webPage/index.html"
    "${CMAKE_CURRENT_SOURCE_DIR}/webPage/style.css"
    "${CMAKE_CURRENT_SOURCE_DIR}/webPage/main.js"
)
set(COMPRESSED_WEB_ASSETS
    "${CMAKE_CURRENT_SOURCE_DIR}/webPage/index.html.gz"
    "${CMAKE_CURRENT_SOURCE_DIR}/webPage/style.css.gz"
    "${CMAKE_CURRENT_SOURCE_DIR}/webPage/main.js.gz"
)
if(NOT CMAKE_SCRIPT_MODE_FILE)
    add_custom_command(
        OUTPUT ${COMPRESSED_WEB_ASSETS}
        COMMAND "${PYTHON}" "${CMAKE_CURRENT_SOURCE_DIR}/compress_web.py" ${WEB_ASSETS}
        DEPENDS ${WEB_ASSETS} "${CMAKE_CURRENT_SOURCE_DIR}/compress_web.py"
        COMMENT "Compressing web assets"
        VERBATIM
    )
    add_custom_target(compressed_web_assets DEPENDS ${COMPRESSED_WEB_ASSETS})
endif()

idf_component_register(
    SRCS
        "main.cpp"
        "application.cpp"
        "adc_stream.cpp"
        "web_server.cpp"
        "wifi_station.cpp"
    INCLUDE_DIRS "."
    REQUIRES
        esp_adc
        esp_event
        esp_http_server
        esp_netif
        esp_wifi
        freertos
        mdns
        nvs_flash
    EMBED_FILES
        "webPage/index.html.gz"
        "webPage/style.css.gz"
        "webPage/main.js.gz"
)
if(NOT CMAKE_SCRIPT_MODE_FILE)
    add_dependencies(${COMPONENT_LIB} compressed_web_assets)
endif()

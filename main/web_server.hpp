#pragma once

#include <cstddef>
#include <cstdint>

#include "esp_http_server.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

namespace scope {

struct SampleRateControl {
    void *context = nullptr;
    uint32_t (*set)(void *context, uint32_t requested_rate) = nullptr;
    uint16_t (*set_bit_widths)(void *context, uint16_t requested_widths) = nullptr;
    uint8_t (*set_channels)(void *context, uint8_t requested_mask) = nullptr;
    uint8_t (*set_attenuation)(void *context, uint8_t requested_attenuation) = nullptr;
};

class WebServer final {
public:
    WebServer() noexcept;
    ~WebServer();

    WebServer(const WebServer &) = delete;
    WebServer &operator=(const WebServer &) = delete;

    void start() noexcept;
    void stop() noexcept;
    void broadcast(const void *data, size_t size) noexcept;
    void set_sample_rate_control(SampleRateControl control) noexcept
    { sample_rate_control_ = control; }

private:
    static esp_err_t send_file(httpd_req_t *request) noexcept;
    static esp_err_t handle_websocket(httpd_req_t *request) noexcept;

    httpd_handle_t handle_ = nullptr;
    SemaphoreHandle_t mutex_ = nullptr;
    SampleRateControl sample_rate_control_;
};

} // namespace scope

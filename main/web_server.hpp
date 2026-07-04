#pragma once

#include <cstddef>

#include "esp_http_server.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

namespace scope {

class WebServer final {
public:
    WebServer() noexcept;
    ~WebServer();

    WebServer(const WebServer &) = delete;
    WebServer &operator=(const WebServer &) = delete;

    void start() noexcept;
    void stop() noexcept;
    void broadcast(const void *data, size_t size) noexcept;

private:
    static esp_err_t send_file(httpd_req_t *request) noexcept;
    static esp_err_t handle_websocket(httpd_req_t *request) noexcept;

    httpd_handle_t handle_ = nullptr;
    SemaphoreHandle_t mutex_ = nullptr;
};

} // namespace scope

#include "web_server.hpp"

#include <array>
#include <charconv>
#include <cinttypes>
#include <cstdio>
#include <cstring>

#include "esp_check.h"
#include "esp_log.h"

namespace {
constexpr char kTag[] = "web_server";
constexpr size_t kMaxClients = 8;

struct EmbeddedFile { const char *start; const char *end; };
struct Route { const char *uri; const char *content_type; EmbeddedFile file; };

extern const char index_html_start[] asm("_binary_index_html_start");
extern const char index_html_end[] asm("_binary_index_html_end");
extern const char main_js_start[] asm("_binary_main_js_start");
extern const char main_js_end[] asm("_binary_main_js_end");
extern const char style_css_start[] asm("_binary_style_css_start");
extern const char style_css_end[] asm("_binary_style_css_end");

const std::array<Route, 3> kRoutes = {{
    {"/", "text/html", {index_html_start, index_html_end}},
    {"/main.js", "text/javascript", {main_js_start, main_js_end}},
    {"/style.css", "text/css", {style_css_start, style_css_end}},
}};

class MutexGuard final {
public:
    explicit MutexGuard(SemaphoreHandle_t handle) noexcept : handle_(handle)
    { xSemaphoreTake(handle_, portMAX_DELAY); }
    ~MutexGuard() { xSemaphoreGive(handle_); }
    MutexGuard(const MutexGuard &) = delete;
    MutexGuard &operator=(const MutexGuard &) = delete;
private:
    SemaphoreHandle_t handle_;
};
} // namespace

scope::WebServer::WebServer() noexcept : mutex_(xSemaphoreCreateMutex())
{
    ESP_ERROR_CHECK(mutex_ == nullptr ? ESP_ERR_NO_MEM : ESP_OK);
}

scope::WebServer::~WebServer()
{
    stop();
    vSemaphoreDelete(mutex_);
}

esp_err_t scope::WebServer::send_file(httpd_req_t *request) noexcept
{
    const auto *route = static_cast<const Route *>(request->user_ctx);
    httpd_resp_set_type(request, route->content_type);
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    return httpd_resp_send(request, route->file.start,
                           route->file.end - route->file.start);
}

esp_err_t scope::WebServer::handle_websocket(httpd_req_t *request) noexcept
{
    auto *server = static_cast<WebServer *>(request->user_ctx);
    if (request->method == HTTP_GET) {
        ESP_LOGI(kTag, "WebSocket connected (fd=%d)", httpd_req_to_sockfd(request));
        return ESP_OK;
    }
    httpd_ws_frame_t frame = {};
    ESP_RETURN_ON_ERROR(httpd_ws_recv_frame(request, &frame, 0), kTag,
                        "Failed to inspect WebSocket frame");
    if (frame.len > 64) return ESP_ERR_INVALID_SIZE;
    char payload[65] = {};
    frame.payload = reinterpret_cast<uint8_t *>(payload);
    if (frame.len != 0) {
        ESP_RETURN_ON_ERROR(httpd_ws_recv_frame(request, &frame, frame.len), kTag,
                            "Failed to receive WebSocket frame");
    }
    if (frame.type != HTTPD_WS_TYPE_TEXT || server->sample_rate_control_.set == nullptr) {
        return ESP_OK;
    }

    constexpr char rate_prefix[] = "rate:";
    constexpr char bits_prefix[] = "bits:";
    constexpr char pin_prefix[] = "pin:";
    constexpr char atten_prefix[] = "atten:";
    uint32_t requested_value = 0;
    const char *response_prefix = nullptr;
    uint32_t value = 0;
    if (std::strncmp(payload, rate_prefix, sizeof(rate_prefix) - 1) == 0) {
        const char *begin = payload + sizeof(rate_prefix) - 1;
        const char *end = payload + frame.len;
        const auto result = std::from_chars(begin, end, requested_value);
        if (result.ec != std::errc{} || result.ptr != end ||
            requested_value < 20000 || requested_value > 2000000) {
            return ESP_ERR_INVALID_ARG;
        }
        response_prefix = "rate:";
        value = server->sample_rate_control_.set(
            server->sample_rate_control_.context, requested_value);
    } else if (std::strncmp(payload, bits_prefix, sizeof(bits_prefix) - 1) == 0) {
        const char *begin = payload + sizeof(bits_prefix) - 1;
        const char *end = payload + frame.len;
        const auto result = std::from_chars(begin, end, requested_value);
        if (result.ec != std::errc{} || result.ptr != end ||
            requested_value < 9 || requested_value > 12 ||
            server->sample_rate_control_.set_bit_width == nullptr) {
            return ESP_ERR_INVALID_ARG;
        }
        response_prefix = "bits:";
        value = server->sample_rate_control_.set_bit_width(
            server->sample_rate_control_.context, requested_value);
    } else if (std::strncmp(payload, pin_prefix, sizeof(pin_prefix) - 1) == 0) {
        const char *begin = payload + sizeof(pin_prefix) - 1;
        const char *end = payload + frame.len;
        const auto result = std::from_chars(begin, end, requested_value);
        const bool valid_gpio = requested_value == 32 || requested_value == 33 ||
            requested_value == 34 || requested_value == 35 ||
            requested_value == 36 || requested_value == 39;
        if (result.ec != std::errc{} || result.ptr != end || !valid_gpio ||
            server->sample_rate_control_.set_gpio == nullptr) return ESP_ERR_INVALID_ARG;
        response_prefix = "pin:";
        value = server->sample_rate_control_.set_gpio(
            server->sample_rate_control_.context, requested_value);
    } else if (std::strncmp(payload, atten_prefix, sizeof(atten_prefix) - 1) == 0) {
        const char *begin = payload + sizeof(atten_prefix) - 1;
        const char *end = payload + frame.len;
        const auto result = std::from_chars(begin, end, requested_value);
        if (result.ec != std::errc{} || result.ptr != end || requested_value > 3 ||
            server->sample_rate_control_.set_attenuation == nullptr) return ESP_ERR_INVALID_ARG;
        response_prefix = "atten:";
        value = server->sample_rate_control_.set_attenuation(
            server->sample_rate_control_.context, requested_value);
    } else if (std::strcmp(payload, "get_rate") == 0) {
        response_prefix = "rate:";
        value = server->sample_rate_control_.set(
            server->sample_rate_control_.context, 0);
    } else if (std::strcmp(payload, "get_bits") == 0 &&
               server->sample_rate_control_.set_bit_width != nullptr) {
        response_prefix = "bits:";
        value = server->sample_rate_control_.set_bit_width(
            server->sample_rate_control_.context, 0);
    } else if (std::strcmp(payload, "get_pin") == 0 &&
               server->sample_rate_control_.set_gpio != nullptr) {
        response_prefix = "pin:";
        value = server->sample_rate_control_.set_gpio(
            server->sample_rate_control_.context, 0);
    } else if (std::strcmp(payload, "get_atten") == 0 &&
               server->sample_rate_control_.set_attenuation != nullptr) {
        response_prefix = "atten:";
        value = server->sample_rate_control_.set_attenuation(
            server->sample_rate_control_.context, UINT8_MAX);
    } else {
        return ESP_ERR_NOT_SUPPORTED;
    }

    char response[32];
    const int response_size = std::snprintf(response, sizeof(response), "%s%" PRIu32,
                                            response_prefix, value);
    httpd_ws_frame_t reply = {};
    reply.type = HTTPD_WS_TYPE_TEXT;
    reply.payload = reinterpret_cast<uint8_t *>(response);
    reply.len = response_size;
    return httpd_ws_send_frame(request, &reply);
}

void scope::WebServer::start() noexcept
{
    const MutexGuard lock{mutex_};
    if (handle_ != nullptr) return;

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    if (httpd_start(&handle_, &config) != ESP_OK) {
        handle_ = nullptr;
        ESP_LOGE(kTag, "Failed to start HTTP server");
        return;
    }
    for (const auto &route : kRoutes) {
        httpd_uri_t handler = {};
        handler.uri = route.uri;
        handler.method = HTTP_GET;
        handler.handler = send_file;
        handler.user_ctx = const_cast<Route *>(&route);
        ESP_ERROR_CHECK(httpd_register_uri_handler(handle_, &handler));
    }
    httpd_uri_t websocket = {};
    websocket.uri = "/ws";
    websocket.method = HTTP_GET;
    websocket.handler = handle_websocket;
    websocket.user_ctx = this;
    websocket.is_websocket = true;
    ESP_ERROR_CHECK(httpd_register_uri_handler(handle_, &websocket));
    ESP_LOGI(kTag, "HTTP server started on port %u", config.server_port);
}

void scope::WebServer::stop() noexcept
{
    const MutexGuard lock{mutex_};
    if (handle_ == nullptr) return;
    httpd_stop(handle_);
    handle_ = nullptr;
    ESP_LOGI(kTag, "HTTP server stopped");
}

void scope::WebServer::broadcast(const void *data, size_t size) noexcept
{
    const MutexGuard lock{mutex_};
    if (handle_ == nullptr) return;

    int sockets[kMaxClients];
    size_t client_count = kMaxClients;
    if (httpd_get_client_list(handle_, &client_count, sockets) != ESP_OK) return;

    httpd_ws_frame_t frame = {};
    frame.type = HTTPD_WS_TYPE_BINARY;
    frame.payload = static_cast<uint8_t *>(const_cast<void *>(data));
    frame.len = size;
    for (size_t i = 0; i < client_count; ++i) {
        if (httpd_ws_get_fd_info(handle_, sockets[i]) == HTTPD_WS_CLIENT_WEBSOCKET &&
            httpd_ws_send_data(handle_, sockets[i], &frame) != ESP_OK) {
            ESP_LOGW(kTag, "Send failed (fd=%d)", sockets[i]);
        }
    }
}

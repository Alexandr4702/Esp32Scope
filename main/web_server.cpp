#include "web_server.hpp"

#include <array>

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
    if (request->method == HTTP_GET) {
        ESP_LOGI(kTag, "WebSocket connected (fd=%d)", httpd_req_to_sockfd(request));
        return ESP_OK;
    }
    httpd_ws_frame_t frame = {};
    ESP_RETURN_ON_ERROR(httpd_ws_recv_frame(request, &frame, 0), kTag,
                        "Failed to inspect WebSocket frame");
    if (frame.len > 64) return ESP_ERR_INVALID_SIZE;
    uint8_t payload[64] = {};
    frame.payload = payload;
    return frame.len == 0 ? ESP_OK : httpd_ws_recv_frame(request, &frame, frame.len);
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

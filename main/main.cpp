/* WebSocket Echo Server Example

   This example code is in the Public Domain (or CC0 licensed, at your option.)

   Unless required by applicable law or agreed to in writing, this
   software is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
   CONDITIONS OF ANY KIND, either express or implied.
*/

#include <esp_wifi.h>
#include <esp_event.h>
#include <esp_log.h>
#include <esp_system.h>
#include <nvs_flash.h>
#include <sys/param.h>
#include "nvs_flash.h"
#include "esp_netif.h"
#include "esp_eth.h"
#include "esp_pthread.h"
#include "protocol_examples_common.h"

#include <esp_http_server.h>

#include <stdio.h>

#include <thread>
#include <vector>

#include "single_include/nlohmann/json.hpp"

struct EmbedFile
{
    const char *start;
    const char *end;
};

struct UriResponse
{
    const char *uri;
    EmbedFile fl;
};

void adc_task(void);

esp_err_t ws_callback(httpd_req_t *req);
esp_err_t send_http_response(httpd_req_t *req);

const char *TAG = "ws_echo_server";
httpd_handle_t server = NULL;
const size_t maxNumberOfClients = 8;

extern const char index_html_start[] asm("_binary_index_html_start");
extern const char index_html_end[] asm("_binary_index_html_end");

extern const char main_js_start[] asm("_binary_main_js_start");
extern const char main_js_end[] asm("_binary_main_js_end");

extern const char style_css_start[] asm("_binary_style_css_start");
extern const char style_css_end[] asm("_binary_style_css_end");

std::vector<UriResponse> UriResponses = {
    {"/", {index_html_start, index_html_end}},
    {"/main.js", {main_js_start, main_js_end}},
    {"/style.css", {style_css_start, style_css_end}}};

const httpd_uri_t ws_cb_header = {
    .uri = "/ws",
    .method = HTTP_GET,
    .handler = ws_callback,
    .user_ctx = NULL,
    .is_websocket = true};

esp_err_t send_http_response(httpd_req_t *req)
{
    EmbedFile *ptr = reinterpret_cast<EmbedFile *>(req->user_ctx);
    uint32_t size = ptr->end - ptr->start;

    httpd_resp_send_chunk(req, ptr->start, size);
    httpd_resp_sendstr_chunk(req, NULL);
    return ESP_OK;
}

esp_err_t ws_callback(httpd_req_t *req)
{
    if (req->method == HTTP_GET)
    {
        int *sockets = new int[maxNumberOfClients];
        size_t numberOfClients = maxNumberOfClients;
        if (httpd_get_client_list(server, &numberOfClients, sockets) == ESP_OK)
        {
            ESP_LOGI(TAG, "Handshake done, the new connection was opened, number of clients: %u", numberOfClients);
        }
        else
        {
            ESP_LOGE(TAG, "Somthing got wrong, number of clients: %u", numberOfClients);
        }
        delete[] sockets;

        return ESP_OK;
    }

    httpd_ws_frame_t ws_pkt;
    uint8_t *buf = NULL;
    memset(&ws_pkt, 0, sizeof(httpd_ws_frame_t));
    ws_pkt.type = HTTPD_WS_TYPE_TEXT;
    /* Set max_len = 0 to get the frame len */
    esp_err_t ret = httpd_ws_recv_frame(req, &ws_pkt, 0);
    if (ret != ESP_OK)
    {
        // ESP_LOGE(TAG, "httpd_ws_recv_frame failed to get frame len with %d", ret);
        return ret;
    }

    if (ws_pkt.len)
    {
        /* ws_pkt.len + 1 is for NULL termination as we are expecting a string */
        buf = reinterpret_cast<uint8_t *>(calloc(1, ws_pkt.len + 1));
        if (buf == NULL)
        {
            // ESP_LOGE(TAG, "Failed to calloc memory for buf");
            return ESP_ERR_NO_MEM;
        }
        ws_pkt.payload = buf;
        /* Set max_len = ws_pkt.len to get the frame payload */
        ret = httpd_ws_recv_frame(req, &ws_pkt, ws_pkt.len);
        if (ret != ESP_OK)
        {
            // ESP_LOGE(TAG, "httpd_ws_recv_frame failed with %d", ret);
            free(buf);
            return ret;
        }
        // ESP_LOGI(TAG, "Got packet with message: %s", ws_pkt.payload);
    }
    // ESP_LOGI(TAG, "Packet type: %d", ws_pkt.type);
    if (ws_pkt.type == HTTPD_WS_TYPE_TEXT &&
        strcmp((char *)ws_pkt.payload, "Trigger async") == 0)
    {
        free(buf);
        return ESP_OK;
    }

    ret = httpd_ws_send_frame(req, &ws_pkt);
    if (ret != ESP_OK)
    {
        // ESP_LOGE(TAG, "httpd_ws_send_frame failed with %d", ret);
    }
    free(buf);
    return ret;
}

httpd_handle_t start_webserver(void)
{
    httpd_handle_t server = NULL;
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();

    // Start the httpd server
    ESP_LOGI(TAG, "Starting server on port: '%d'", config.server_port);
    if (httpd_start(&server, &config) == ESP_OK)
    {
        httpd_uri_t CbHeader = {
            .method = HTTP_GET,
            .handler = send_http_response,
            .is_websocket = false};

        for (const auto &resp : UriResponses)
        {
            CbHeader.uri = resp.uri;
            CbHeader.user_ctx = const_cast<EmbedFile *>(&resp.fl);
            httpd_register_uri_handler(server, &CbHeader);
        }

        httpd_register_uri_handler(server, &ws_cb_header);

        return server;
    }

    ESP_LOGI(TAG, "Error starting server!");
    return NULL;
}

void stop_webserver(httpd_handle_t server)
{
    httpd_stop(server);
}

void disconnect_handler(void *arg, esp_event_base_t event_base,
                        int32_t event_id, void *event_data)
{
    ESP_LOGI(TAG, "Wifi Disconncted");

    httpd_handle_t *server = (httpd_handle_t *)arg;
    if (*server)
    {
        ESP_LOGI(TAG, "Stopping webserver");
        stop_webserver(*server);
        *server = NULL;
    }
}

void connect_handler(void *arg, esp_event_base_t event_base,
                     int32_t event_id, void *event_data)
{
    ESP_LOGI(TAG, "Wifi Connected");

    httpd_handle_t *server = (httpd_handle_t *)arg;
    if (*server == NULL)
    {
        ESP_LOGI(TAG, "Starting webserver");
        *server = start_webserver();
    }
}

void sendWsData2Clients(const void *data, const size_t size_of_data)
{
    if (server == NULL)
    {
        return;
    }

    int sockets[maxNumberOfClients];
    size_t number_of_clients = maxNumberOfClients;
    if (httpd_get_client_list(server, &number_of_clients, sockets) == ESP_OK)
    {
        for (int i = 0; i < number_of_clients; i++)
        {
            if (httpd_ws_get_fd_info(server, sockets[i]) == HTTPD_WS_CLIENT_WEBSOCKET)
            {

                httpd_ws_frame_t to_send;
                to_send.final = 1;
                to_send.fragmented = 0;
                to_send.type = HTTPD_WS_TYPE_TEXT;
                to_send.payload = reinterpret_cast<uint8_t *>(const_cast<void *>(data));
                to_send.len = size_of_data;
                if (httpd_ws_send_frame_async(server, sockets[i], &to_send) == ESP_OK)
                {
                }
                else
                {
                    ESP_LOGE(TAG, "Failed send data len %u ", size_of_data);
                }
            }
        }
    }
}

extern "C"
{
    void app_main(void)
    {
        ESP_ERROR_CHECK(nvs_flash_init());
        ESP_ERROR_CHECK(esp_netif_init());
        ESP_ERROR_CHECK(esp_event_loop_create_default());

        ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &connect_handler, &server));
        ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, &disconnect_handler, &server));

        ESP_ERROR_CHECK(example_connect());

        esp_pthread_cfg_t default_cfg = esp_pthread_get_default_config();
        default_cfg.stack_size = 4096;
        esp_pthread_set_cfg(&default_cfg);
        std::thread adc_task_handler(adc_task);
        adc_task_handler.detach();

        vTaskDelete(NULL);
    }
}
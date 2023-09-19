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
#include "protocol_examples_common.h"

#include <esp_http_server.h>

#include <stdio.h>

#include "single_include/nlohmann/json.hpp"

void async_sender(void *);

esp_err_t ws_callback(httpd_req_t *req);
esp_err_t main_handler_callback(httpd_req_t *req);
esp_err_t main_js_script_callback(httpd_req_t *req);
esp_err_t style_css_callback(httpd_req_t *req);

static const char *TAG = "ws_echo_server";
httpd_handle_t server = NULL;
TaskHandle_t async_sender_handler;
const size_t maxNumberOfClients = 8;

static const httpd_uri_t index_html_cb_header = {
    .uri = "/",
    .method = HTTP_GET,
    .handler = main_handler_callback,
    .user_ctx = NULL,
    .is_websocket = false};

static const httpd_uri_t main_js_script_cb_header = {
    .uri = "/main.js",
    .method = HTTP_GET,
    .handler = main_js_script_callback,
    .user_ctx = NULL,
    .is_websocket = false};

static const httpd_uri_t style_css_cb_header = {
    .uri = "/style.css",
    .method = HTTP_GET,
    .handler = style_css_callback,
    .user_ctx = NULL,
    .is_websocket = false};

static const httpd_uri_t ws_cb_header = {
    .uri = "/ws",
    .method = HTTP_GET,
    .handler = ws_callback,
    .user_ctx = NULL,
    .is_websocket = true};

esp_err_t main_handler_callback(httpd_req_t *req)
{
    esp_err_t ret = ESP_OK;

    extern const unsigned char index_html_start[] asm("_binary_index_html_start");
    extern const unsigned char index_html_end[] asm("_binary_index_html_end");
    uint32_t ws_test_html_size = index_html_end - index_html_start;

    httpd_resp_send_chunk(req, (const char *)index_html_start, ws_test_html_size);
    httpd_resp_sendstr_chunk(req, NULL);
    return ret;
}

esp_err_t main_js_script_callback(httpd_req_t *req)
{
    esp_err_t ret = ESP_OK;

    extern const unsigned char main_js_start[] asm("_binary_main_js_start");
    extern const unsigned char main_js_end[] asm("_binary_main_js_end");
    uint32_t size = main_js_end - main_js_start;

    httpd_resp_send_chunk(req, (const char *)main_js_start, size);
    httpd_resp_sendstr_chunk(req, NULL);
    return ret;
}

esp_err_t style_css_callback(httpd_req_t *req)
{
    esp_err_t ret = ESP_OK;

    extern const unsigned char style_css_start[] asm("_binary_style_css_start");
    extern const unsigned char style_css_end[] asm("_binary_style_css_end");
    uint32_t size = style_css_end - style_css_start;

    httpd_resp_send_chunk(req, (const char *)style_css_start, size);
    httpd_resp_sendstr_chunk(req, NULL);
    return ret;
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

static httpd_handle_t start_webserver(void)
{
    httpd_handle_t server = NULL;
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();

    // Start the httpd server
    ESP_LOGI(TAG, "Starting server on port: '%d'", config.server_port);
    if (httpd_start(&server, &config) == ESP_OK)
    {
        // Registering the ws handler
        ESP_LOGI(TAG, "Registering URI handlers");
        httpd_register_uri_handler(server, &index_html_cb_header);
        httpd_register_uri_handler(server, &main_js_script_cb_header);
        httpd_register_uri_handler(server, &style_css_cb_header);
        httpd_register_uri_handler(server, &ws_cb_header);

        xTaskCreate(async_sender, "async_sender", 4096, NULL, configMAX_PRIORITIES - 5, &async_sender_handler);
        return server;
    }

    ESP_LOGI(TAG, "Error starting server!");
    return NULL;
}

static void stop_webserver(httpd_handle_t server)
{
    // Stop the httpd server
    vTaskDelete(async_sender_handler);
    httpd_stop(server);
}

static void disconnect_handler(void *arg, esp_event_base_t event_base,
                               int32_t event_id, void *event_data)
{
    httpd_handle_t *server = (httpd_handle_t *)arg;
    if (*server)
    {
        ESP_LOGI(TAG, "Stopping webserver");
        stop_webserver(*server);
        *server = NULL;
    }
}

static void connect_handler(void *arg, esp_event_base_t event_base,
                            int32_t event_id, void *event_data)
{
    httpd_handle_t *server = (httpd_handle_t *)arg;
    if (*server == NULL)
    {
        ESP_LOGI(TAG, "Starting webserver");
        *server = start_webserver();
    }
}

void sendData2Clients(const void* data, const size_t size_of_data)
{
    int sockets[maxNumberOfClients];
    size_t number_of_clients = maxNumberOfClients;
    if (httpd_get_client_list(server, &number_of_clients, sockets) == ESP_OK)
    {
        // fprintf(stdout, "Numbers of sockets:%u \r\n", size);
        for (int i = 0; i < number_of_clients; i++)
        {
            if (httpd_ws_get_fd_info(server, sockets[i]) == HTTPD_WS_CLIENT_WEBSOCKET)
            {

                httpd_ws_frame_t to_send;
                to_send.final = 1;
                to_send.fragmented = 0;
                to_send.type = HTTPD_WS_TYPE_TEXT;
                to_send.payload = reinterpret_cast<uint8_t*> (const_cast<void*> (data));
                to_send.len = size_of_data;
                if (httpd_ws_send_frame_async(server, sockets[i], &to_send) == ESP_OK)
                {
                    // fprintf(stdout, "Send data len %u \r\n", len);
                }
                else
                {
                    ESP_LOGE(TAG, "Failed send data len %u ", size_of_data);
                }
            }
        }
    }
}

void async_sender(void *)
{
    int *sockets = new int[maxNumberOfClients];
    std::vector<uint16_t> data_to_send = {10, 12, 13};
    while (1)
    {
        uint32_t uptime_ms = xTaskGetTickCount() * portTICK_PERIOD_MS;
        double uptime_s = uptime_ms / 1000.0;

        using json = nlohmann::json;
        using namespace std;
        json test;
        test["uptime"] = uptime_s;
        test["Ch1Data"] = data_to_send;

        string data = test.dump();
        uint32_t len = data.size();

        sendData2Clients(data.c_str(), len);

        vTaskDelay(10 / portTICK_PERIOD_MS);
    }
}

extern "C"
{
    void app_main(void)
    {
        ESP_ERROR_CHECK(nvs_flash_init());
        ESP_ERROR_CHECK(esp_netif_init());
        ESP_ERROR_CHECK(esp_event_loop_create_default());

        /* This helper function configures Wi-Fi or Ethernet, as selected in menuconfig.
         * Read "Establishing Wi-Fi or Ethernet Connection" section in
         * examples/protocols/README.md for more information about this function.
         */
        ESP_ERROR_CHECK(example_connect());

        /* Register event handlers to stop the server when Wi-Fi or Ethernet is disconnected,
         * and re-start it upon connection.
         */
#ifdef CONFIG_EXAMPLE_CONNECT_WIFI
        ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &connect_handler, &server));
        ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, &disconnect_handler, &server));
#endif // CONFIG_EXAMPLE_CONNECT_WIFI
#ifdef CONFIG_EXAMPLE_CONNECT_ETHERNET
        ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_GOT_IP, &connect_handler, &server));
        ESP_ERROR_CHECK(esp_event_handler_register(ETH_EVENT, ETHERNET_EVENT_DISCONNECTED, &disconnect_handler, &server));
#endif // CONFIG_EXAMPLE_CONNECT_ETHERNET

        /* Start the server for the first time */
        server = start_webserver();
    }
}
#include "wifi_station.hpp"

#include <cstring>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"

namespace { constexpr char kTag[] = "wifi_station"; }

void scope::WifiStation::event_adapter(void *context, esp_event_base_t base,
                                       int32_t event_id, void *) noexcept
{
    static_cast<WifiStation *>(context)->handle_event(base, event_id);
}

void scope::WifiStation::handle_event(esp_event_base_t base, int32_t event_id) noexcept
{
    if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        ESP_ERROR_CHECK(esp_wifi_connect());
    } else if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        ESP_LOGW(kTag, "Disconnected; reconnecting");
        if (callbacks_.disconnected) callbacks_.disconnected(callbacks_.context);
        esp_wifi_connect();
    } else if (base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ESP_LOGI(kTag, "IP address acquired; open http://%s.local/",
                 CONFIG_SCOPE_MDNS_HOSTNAME);
        if (callbacks_.connected) callbacks_.connected(callbacks_.context);
    }
}

void scope::WifiStation::start(ConnectionCallbacks callbacks) noexcept
{
    callbacks_ = callbacks;
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t init_config = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init_config));

    wifi_config_t config = {};
    static_assert(sizeof(CONFIG_SCOPE_WIFI_SSID) <= sizeof(config.sta.ssid));
    static_assert(sizeof(CONFIG_SCOPE_WIFI_PASSWORD) <= sizeof(config.sta.password));
    std::memcpy(config.sta.ssid, CONFIG_SCOPE_WIFI_SSID, sizeof(CONFIG_SCOPE_WIFI_SSID));
    std::memcpy(config.sta.password, CONFIG_SCOPE_WIFI_PASSWORD,
                sizeof(CONFIG_SCOPE_WIFI_PASSWORD));
    config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    config.sta.pmf_cfg.capable = true;

    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                event_adapter, this));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                event_adapter, this));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &config));
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    ESP_ERROR_CHECK(esp_wifi_start());
}

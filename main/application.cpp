#include "application.hpp"

#include "adc_stream.hpp"

#include "esp_event.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "freertos/task.h"
#include "mdns.h"
#include "nvs_flash.h"

scope::Application &scope::Application::instance() noexcept
{
    static Application application;
    return application;
}

void scope::Application::start() noexcept
{
    initialize_nvs();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    initialize_mdns();
    web_server_.set_sample_rate_control(
        {this, sample_rate, bit_width, gpio, attenuation});

    wifi_.start({this, connection_started, connection_stopped});

    // Wi-Fi is pinned to core 0 by ESP-IDF; acquisition owns core 1.
    const BaseType_t created = xTaskCreatePinnedToCore(
        adc_task, kAdcTaskName, kAdcTaskStackSize, this,
        kAdcTaskPriority, nullptr, kAdcCore);
    ESP_ERROR_CHECK(created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);
}

void scope::Application::connection_started(void *context) noexcept
{
    static_cast<Application *>(context)->web_server_.start();
}

void scope::Application::connection_stopped(void *context) noexcept
{
    static_cast<Application *>(context)->web_server_.stop();
}

void scope::Application::send_samples(void *context, const void *data,
                                      size_t size) noexcept
{
    static_cast<Application *>(context)->web_server_.broadcast(data, size);
}

uint32_t scope::Application::sample_rate(void *context,
                                         uint32_t requested_rate) noexcept
{
    auto *application = static_cast<Application *>(context);
    if (requested_rate != 0) {
        application->requested_sample_rate_.store(requested_rate);
    }
    return application->requested_sample_rate_.load();
}

uint8_t scope::Application::bit_width(void *context,
                                      uint8_t requested_width) noexcept
{
    auto *application = static_cast<Application *>(context);
    if (requested_width != 0) {
        application->requested_bit_width_.store(requested_width);
    }
    return application->requested_bit_width_.load();
}

uint8_t scope::Application::gpio(void *context, uint8_t requested_gpio) noexcept
{
    auto *application = static_cast<Application *>(context);
    if (requested_gpio != 0) application->requested_gpio_.store(requested_gpio);
    return application->requested_gpio_.load();
}

uint8_t scope::Application::attenuation(void *context,
                                        uint8_t requested_attenuation) noexcept
{
    auto *application = static_cast<Application *>(context);
    if (requested_attenuation != UINT8_MAX) {
        application->requested_attenuation_.store(requested_attenuation);
    }
    return application->requested_attenuation_.load();
}

void scope::Application::initialize_nvs() noexcept
{
    esp_err_t result = nvs_flash_init();
    if (result == ESP_ERR_NVS_NO_FREE_PAGES ||
        result == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        result = nvs_flash_init();
    }
    ESP_ERROR_CHECK(result);
}

void scope::Application::initialize_mdns() noexcept
{
    ESP_ERROR_CHECK(mdns_init());
    ESP_ERROR_CHECK(mdns_hostname_set(CONFIG_SCOPE_MDNS_HOSTNAME));
    ESP_ERROR_CHECK(mdns_instance_name_set("ESP32 Scope"));
    ESP_ERROR_CHECK(mdns_service_add("ESP32 Scope", "_http", "_tcp", 80,
                                     nullptr, 0));
}

[[noreturn]] void scope::Application::adc_task(void *context) noexcept
{
    auto *application = static_cast<Application *>(context);
    AdcStream stream{{application, send_samples},
                     application->requested_sample_rate_,
                     application->requested_bit_width_, application->requested_gpio_,
                     application->requested_attenuation_};
    stream.run();
}

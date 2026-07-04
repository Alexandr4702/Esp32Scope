#include "application.hpp"

#include "adc_stream.hpp"

#include "esp_event.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "freertos/task.h"
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

[[noreturn]] void scope::Application::adc_task(void *context) noexcept
{
    auto *application = static_cast<Application *>(context);
    AdcStream stream{{application, send_samples}};
    stream.run();
}

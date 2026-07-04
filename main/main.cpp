#include "adc_stream.hpp"
#include "web_server.hpp"
#include "wifi_station.hpp"

#include "esp_event.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

namespace scope {

class Application final {
public:
    void start() noexcept
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

    Application(const Application &) = delete;
    Application &operator=(const Application &) = delete;

    static Application &instance() noexcept
    {
        static Application application;
        return application;
    }

private:
    static constexpr char kAdcTaskName[] = "adc_stream";
    static constexpr uint32_t kAdcTaskStackSize = 6144;
    static constexpr UBaseType_t kAdcTaskPriority = 18;
    static constexpr BaseType_t kAdcCore = 1;

    Application() = default;

    static void connection_started(void *context) noexcept
    {
        static_cast<Application *>(context)->web_server_.start();
    }

    static void connection_stopped(void *context) noexcept
    {
        static_cast<Application *>(context)->web_server_.stop();
    }

    static void send_samples(void *context, const void *data, size_t size) noexcept
    {
        static_cast<Application *>(context)->web_server_.broadcast(data, size);
    }

    static void initialize_nvs() noexcept
    {
        esp_err_t result = nvs_flash_init();
        if (result == ESP_ERR_NVS_NO_FREE_PAGES ||
            result == ESP_ERR_NVS_NEW_VERSION_FOUND) {
            ESP_ERROR_CHECK(nvs_flash_erase());
            result = nvs_flash_init();
        }
        ESP_ERROR_CHECK(result);
    }

    [[noreturn]] static void adc_task(void *context) noexcept
    {
        auto *application = static_cast<Application *>(context);
        AdcStream stream{{application, send_samples}};
        stream.run();
    }

    WebServer web_server_;
    WifiStation wifi_;
};

} // namespace scope

extern "C" void app_main()
{
    scope::Application::instance().start();
}

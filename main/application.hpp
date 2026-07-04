#pragma once

#include <cstddef>
#include <cstdint>

#include "freertos/FreeRTOS.h"

#include "web_server.hpp"
#include "wifi_station.hpp"

namespace scope {

class Application final {
public:
    Application(const Application &) = delete;
    Application &operator=(const Application &) = delete;

    static Application &instance() noexcept;
    void start() noexcept;

private:
    static constexpr char kAdcTaskName[] = "adc_stream";
    static constexpr uint32_t kAdcTaskStackSize = 6144;
    static constexpr UBaseType_t kAdcTaskPriority = 18;
    static constexpr BaseType_t kAdcCore = 1;

    Application() = default;

    static void connection_started(void *context) noexcept;
    static void connection_stopped(void *context) noexcept;
    static void send_samples(void *context, const void *data, size_t size) noexcept;
    static void initialize_nvs() noexcept;
    [[noreturn]] static void adc_task(void *context) noexcept;

    WebServer web_server_;
    WifiStation wifi_;
};

} // namespace scope

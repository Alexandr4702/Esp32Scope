#pragma once

#include <cstddef>
#include <atomic>
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
    static uint32_t sample_rate(void *context, uint32_t requested_rate) noexcept;
    static uint8_t bit_width(void *context, uint8_t requested_width) noexcept;
    static uint8_t channels(void *context, uint8_t requested_mask) noexcept;
    static uint8_t attenuation(void *context, uint8_t requested_attenuation) noexcept;
    static void initialize_nvs() noexcept;
    static void initialize_mdns() noexcept;
    [[noreturn]] static void adc_task(void *context) noexcept;

    WebServer web_server_;
    WifiStation wifi_;
    std::atomic<uint32_t> requested_sample_rate_{CONFIG_SCOPE_SAMPLE_RATE_HZ};
    std::atomic<uint8_t> requested_bit_width_{12};
    std::atomic<uint8_t> requested_channel_mask_{1u << 2};
    std::atomic<uint8_t> requested_attenuation_{3};
};

} // namespace scope

#pragma once

#include "esp_event_base.h"

namespace scope {

struct ConnectionCallbacks {
    void *context = nullptr;
    void (*connected)(void *context) = nullptr;
    void (*disconnected)(void *context) = nullptr;
};

class WifiStation final {
public:
    WifiStation() = default;
    WifiStation(const WifiStation &) = delete;
    WifiStation &operator=(const WifiStation &) = delete;

    void start(ConnectionCallbacks callbacks) noexcept;

private:
    static void event_adapter(void *context, esp_event_base_t base,
                              int32_t event_id, void *event_data) noexcept;
    void handle_event(esp_event_base_t base, int32_t event_id) noexcept;

    ConnectionCallbacks callbacks_{};
};

} // namespace scope

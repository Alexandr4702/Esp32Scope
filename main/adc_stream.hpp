#pragma once

#include <cstddef>
#include <atomic>
#include <cstdint>

namespace scope {

struct DataSink {
    void *context = nullptr;
    void (*send)(void *context, const void *data, size_t size) = nullptr;
};

class AdcStream final {
public:
    AdcStream(DataSink sink, std::atomic<uint32_t> &requested_sample_rate,
              std::atomic<uint8_t> &requested_bit_width,
              std::atomic<uint8_t> &requested_gpio,
              std::atomic<uint8_t> &requested_attenuation) noexcept
        : sink_(sink), requested_sample_rate_(requested_sample_rate),
          requested_bit_width_(requested_bit_width), requested_gpio_(requested_gpio),
          requested_attenuation_(requested_attenuation) {}

    AdcStream(const AdcStream &) = delete;
    AdcStream &operator=(const AdcStream &) = delete;

    [[noreturn]] void run() noexcept;

private:
    DataSink sink_;
    std::atomic<uint32_t> &requested_sample_rate_;
    std::atomic<uint8_t> &requested_bit_width_;
    std::atomic<uint8_t> &requested_gpio_;
    std::atomic<uint8_t> &requested_attenuation_;
};

} // namespace scope

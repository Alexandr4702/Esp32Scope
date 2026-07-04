#pragma once

#include <cstddef>

namespace scope {

struct DataSink {
    void *context = nullptr;
    void (*send)(void *context, const void *data, size_t size) = nullptr;
};

class AdcStream final {
public:
    explicit AdcStream(DataSink sink) noexcept : sink_(sink) {}

    AdcStream(const AdcStream &) = delete;
    AdcStream &operator=(const AdcStream &) = delete;

    [[noreturn]] void run() noexcept;

private:
    DataSink sink_;
};

} // namespace scope

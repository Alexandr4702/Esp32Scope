#include <cstddef>
#include <cstdint>
#include <cinttypes>
#include <cstring>

#include "adc_stream.hpp"
#include "esp_adc/adc_continuous.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "soc/adc_channel.h"

namespace {
constexpr size_t kAdcBufferSize = 8192;
constexpr size_t kProtobufOverhead = 16;
constexpr size_t kPackedHeaderSize = 4;
constexpr uint8_t kPackedMagic = 0xa5;
static uint8_t adc_data[kAdcBufferSize];
static uint8_t protobuf_message[kAdcBufferSize + kProtobufOverhead];

const char *tag = "adc";

size_t encode_varint(uint32_t value, uint8_t *output)
{
    size_t size = 0;
    do {
        uint8_t byte = value & 0x7f;
        value >>= 7;
        output[size++] = value == 0 ? byte : byte | 0x80;
    } while (value != 0);
    return size;
}

void configure_adc(adc_continuous_handle_t handle, uint32_t sample_rate,
                   uint8_t bit_width, uint8_t gpio, uint8_t attenuation)
{
    adc_unit_t unit;
    adc_channel_t channel;
    ESP_ERROR_CHECK(adc_continuous_io_to_channel(gpio, &unit, &channel));
    ESP_ERROR_CHECK(unit == ADC_UNIT_1 ? ESP_OK : ESP_ERR_INVALID_ARG);
    adc_digi_pattern_config_t pattern[1] = {};
    pattern[0].atten = static_cast<adc_atten_t>(attenuation);
    pattern[0].channel = channel & 0x7;
    pattern[0].unit = ADC_UNIT_1;
    pattern[0].bit_width = bit_width;

    const adc_continuous_config_t config = {
        .pattern_num = 1,
        .adc_pattern = pattern,
        .sample_freq_hz = sample_rate,
        .conv_mode = ADC_CONV_SINGLE_UNIT_1,
        .format = ADC_DIGI_OUTPUT_FORMAT_TYPE1,
    };
    ESP_ERROR_CHECK(adc_continuous_config(handle, &config));
}

size_t pack_samples(const uint8_t *input, size_t input_size, uint8_t bit_width,
                    uint8_t *output)
{
    const size_t sample_count = input_size / sizeof(adc_digi_output_data_t);
    output[0] = kPackedMagic;
    output[1] = bit_width;
    output[2] = sample_count & 0xff;
    output[3] = (sample_count >> 8) & 0xff;

    const uint32_t mask = (1u << bit_width) - 1;
    uint32_t accumulator = 0;
    unsigned accumulated_bits = 0;
    size_t output_size = kPackedHeaderSize;
    for (size_t i = 0; i < sample_count; ++i) {
        const uint16_t raw = static_cast<uint16_t>(input[i * 2]) |
                             (static_cast<uint16_t>(input[i * 2 + 1]) << 8);
        accumulator |= (raw & mask) << accumulated_bits;
        accumulated_bits += bit_width;
        while (accumulated_bits >= 8) {
            output[output_size++] = accumulator & 0xff;
            accumulator >>= 8;
            accumulated_bits -= 8;
        }
    }
    if (accumulated_bits != 0) output[output_size++] = accumulator & 0xff;
    return output_size;
}

adc_continuous_handle_t initialize_adc(uint32_t sample_rate, uint8_t bit_width,
                                       uint8_t gpio, uint8_t attenuation)
{
    adc_continuous_handle_t handle = nullptr;
    adc_continuous_handle_cfg_t handle_config = {};
    handle_config.max_store_buf_size = kAdcBufferSize * 4;
    handle_config.conv_frame_size = kAdcBufferSize;
    ESP_ERROR_CHECK(adc_continuous_new_handle(&handle_config, &handle));

    configure_adc(handle, sample_rate, bit_width, gpio, attenuation);
    return handle;
}
} // namespace

[[noreturn]] void scope::AdcStream::run() noexcept
{
    ESP_ERROR_CHECK(sink_.send == nullptr ? ESP_ERR_INVALID_ARG : ESP_OK);
    uint32_t active_sample_rate = requested_sample_rate_.load();
    uint8_t active_bit_width = requested_bit_width_.load();
    uint8_t active_gpio = requested_gpio_.load();
    uint8_t active_attenuation = requested_attenuation_.load();
    adc_continuous_handle_t handle = initialize_adc(active_sample_rate,
        active_bit_width, active_gpio, active_attenuation);
    ESP_ERROR_CHECK(adc_continuous_start(handle));
    ESP_LOGI(tag, "ADC running at %" PRIu32 " Sa/s", active_sample_rate);

    while (true) {
        const uint32_t requested_sample_rate = requested_sample_rate_.load();
        const uint8_t requested_bit_width = requested_bit_width_.load();
        const uint8_t requested_gpio = requested_gpio_.load();
        const uint8_t requested_attenuation = requested_attenuation_.load();
        if (requested_sample_rate != active_sample_rate ||
            requested_bit_width != active_bit_width || requested_gpio != active_gpio ||
            requested_attenuation != active_attenuation) {
            ESP_ERROR_CHECK(adc_continuous_stop(handle));
            configure_adc(handle, requested_sample_rate, requested_bit_width,
                          requested_gpio, requested_attenuation);
            ESP_ERROR_CHECK(adc_continuous_start(handle));
            active_sample_rate = requested_sample_rate;
            active_bit_width = requested_bit_width;
            active_gpio = requested_gpio;
            active_attenuation = requested_attenuation;
            ESP_LOGI(tag, "ADC: %" PRIu32 " Sa/s, %u bits, GPIO%u, atten %u",
                     active_sample_rate, active_bit_width, active_gpio,
                     active_attenuation);
        }
        uint32_t bytes_read = 0;
        const esp_err_t result = adc_continuous_read(
            handle, adc_data, sizeof(adc_data), &bytes_read, portMAX_DELAY);

        if (result == ESP_OK) {
            size_t offset = 0;
            const size_t sample_count =
                bytes_read / sizeof(adc_digi_output_data_t);
            const size_t packed_size =
                kPackedHeaderSize + (sample_count * active_bit_width + 7) / 8;
            protobuf_message[offset++] = 0x0a; // field 1: adcData (bytes)
            offset += encode_varint(packed_size, protobuf_message + offset);
            offset += pack_samples(adc_data, bytes_read, active_bit_width,
                                   protobuf_message + offset);
            protobuf_message[offset++] = 0x10; // field 2: numberOfData (int32)
            offset += encode_varint(sample_count, protobuf_message + offset);
            sink_.send(sink_.context, protobuf_message, offset);
        } else if (result != ESP_ERR_TIMEOUT) {
            ESP_LOGE(tag, "ADC read failed: %s", esp_err_to_name(result));
        }
    }
}

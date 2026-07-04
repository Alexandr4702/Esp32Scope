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
constexpr size_t kMaxChannels = 6;
constexpr size_t kPackedHeaderSize = 17;
constexpr uint8_t kPackedMagic = 0xa5;
constexpr uint8_t kGpios[kMaxChannels] = {32, 33, 34, 35, 36, 39};
constexpr uint8_t kAdcChannels[kMaxChannels] = {4, 5, 6, 7, 0, 3};
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
                   uint16_t bit_widths, uint8_t channel_mask,
                   uint8_t attenuation)
{
    adc_digi_pattern_config_t pattern[kMaxChannels] = {};
    uint8_t channel_count = 0;
    for (size_t i = 0; i < kMaxChannels; ++i) {
        if ((channel_mask & (1u << i)) == 0) continue;
        adc_unit_t unit;
        adc_channel_t channel;
        ESP_ERROR_CHECK(adc_continuous_io_to_channel(kGpios[i], &unit, &channel));
        ESP_ERROR_CHECK(unit == ADC_UNIT_1 ? ESP_OK : ESP_ERR_INVALID_ARG);
        pattern[channel_count].atten = static_cast<adc_atten_t>(attenuation);
        pattern[channel_count].channel = channel & 0x7;
        pattern[channel_count].unit = ADC_UNIT_1;
        pattern[channel_count].bit_width = 9 + ((bit_widths >> (i * 2)) & 0x3);
        ++channel_count;
    }
    ESP_ERROR_CHECK(channel_count == 0 ? ESP_ERR_INVALID_ARG : ESP_OK);

    const adc_continuous_config_t config = {
        .pattern_num = channel_count,
        .adc_pattern = pattern,
        .sample_freq_hz = sample_rate,
        .conv_mode = ADC_CONV_SINGLE_UNIT_1,
        .format = ADC_DIGI_OUTPUT_FORMAT_TYPE1,
    };
    ESP_ERROR_CHECK(adc_continuous_config(handle, &config));
}

size_t pack_samples(const uint8_t *input, size_t input_size, uint16_t bit_widths,
                    uint8_t channel_mask, uint8_t *output)
{
    const size_t sample_count = input_size / sizeof(adc_digi_output_data_t);
    output[0] = kPackedMagic;
    uint8_t channel_count = 0;
    uint8_t active_widths[kMaxChannels] = {};
    for (size_t i = 0; i < kMaxChannels; ++i) {
        if ((channel_mask & (1u << i)) == 0) continue;
        output[3 + channel_count] = kGpios[i];
        active_widths[channel_count] = 9 + ((bit_widths >> (i * 2)) & 0x3);
        output[9 + channel_count] = active_widths[channel_count];
        ++channel_count;
    }
    output[1] = channel_count;
    for (size_t i = channel_count; i < kMaxChannels; ++i) {
        output[3 + i] = 0;
        output[9 + i] = 0;
    }
    const uint8_t first_adc_channel = input[1] >> 4;
    uint8_t first_channel_index = 0;
    uint8_t active_index = 0;
    for (size_t i = 0; i < kMaxChannels; ++i) {
        if ((channel_mask & (1u << i)) == 0) continue;
        if (kAdcChannels[i] == first_adc_channel) first_channel_index = active_index;
        ++active_index;
    }
    output[2] = first_channel_index;
    output[15] = sample_count & 0xff;
    output[16] = (sample_count >> 8) & 0xff;

    uint32_t accumulator = 0;
    unsigned accumulated_bits = 0;
    size_t output_size = kPackedHeaderSize;
    for (size_t i = 0; i < sample_count; ++i) {
        const uint8_t bit_width = active_widths[(first_channel_index + i) % channel_count];
        const uint32_t mask = (1u << bit_width) - 1;
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

adc_continuous_handle_t initialize_adc(uint32_t sample_rate, uint16_t bit_widths,
                                       uint8_t channel_mask,
                                       uint8_t attenuation)
{
    adc_continuous_handle_t handle = nullptr;
    adc_continuous_handle_cfg_t handle_config = {};
    handle_config.max_store_buf_size = kAdcBufferSize * 4;
    handle_config.conv_frame_size = kAdcBufferSize;
    ESP_ERROR_CHECK(adc_continuous_new_handle(&handle_config, &handle));

    configure_adc(handle, sample_rate, bit_widths, channel_mask, attenuation);
    return handle;
}
} // namespace

[[noreturn]] void scope::AdcStream::run() noexcept
{
    ESP_ERROR_CHECK(sink_.send == nullptr ? ESP_ERR_INVALID_ARG : ESP_OK);
    uint32_t active_sample_rate = requested_sample_rate_.load();
    uint16_t active_bit_widths = requested_bit_widths_.load();
    uint8_t active_channel_mask = requested_channel_mask_.load();
    uint8_t active_attenuation = requested_attenuation_.load();
    adc_continuous_handle_t handle = initialize_adc(active_sample_rate,
        active_bit_widths, active_channel_mask, active_attenuation);
    ESP_ERROR_CHECK(adc_continuous_start(handle));
    ESP_LOGI(tag, "ADC running at %" PRIu32 " Sa/s", active_sample_rate);

    while (true) {
        const uint32_t requested_sample_rate = requested_sample_rate_.load();
        const uint16_t requested_bit_widths = requested_bit_widths_.load();
        const uint8_t requested_channel_mask = requested_channel_mask_.load();
        const uint8_t requested_attenuation = requested_attenuation_.load();
        if (requested_sample_rate != active_sample_rate ||
            requested_bit_widths != active_bit_widths ||
            requested_channel_mask != active_channel_mask ||
            requested_attenuation != active_attenuation) {
            ESP_ERROR_CHECK(adc_continuous_stop(handle));
            configure_adc(handle, requested_sample_rate, requested_bit_widths,
                          requested_channel_mask, requested_attenuation);
            ESP_ERROR_CHECK(adc_continuous_start(handle));
            active_sample_rate = requested_sample_rate;
            active_bit_widths = requested_bit_widths;
            active_channel_mask = requested_channel_mask;
            active_attenuation = requested_attenuation;
            ESP_LOGI(tag, "ADC: %" PRIu32 " Sa/s, widths 0x%03x, mask 0x%02x, atten %u",
                     active_sample_rate, active_bit_widths, active_channel_mask,
                     active_attenuation);
        }
        uint32_t bytes_read = 0;
        const esp_err_t result = adc_continuous_read(
            handle, adc_data, sizeof(adc_data), &bytes_read, portMAX_DELAY);

        if (result == ESP_OK) {
            size_t offset = 3;
            const size_t sample_count =
                bytes_read / sizeof(adc_digi_output_data_t);
            const size_t packed_size = pack_samples(adc_data, bytes_read,
                                   active_bit_widths,
                                   active_channel_mask,
                                   protobuf_message + offset);
            protobuf_message[0] = 0x0a; // field 1: adcData (bytes)
            ESP_ERROR_CHECK(encode_varint(packed_size, protobuf_message + 1) == 2
                                ? ESP_OK : ESP_ERR_INVALID_SIZE);
            offset += packed_size;
            protobuf_message[offset++] = 0x10; // field 2: numberOfData (int32)
            offset += encode_varint(sample_count, protobuf_message + offset);
            sink_.send(sink_.context, protobuf_message, offset);
        } else if (result != ESP_ERR_TIMEOUT) {
            ESP_LOGE(tag, "ADC read failed: %s", esp_err_to_name(result));
        }
    }
}

#include <cstddef>
#include <cstdint>
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
static uint8_t adc_data[kAdcBufferSize];
static uint8_t protobuf_message[kAdcBufferSize + kProtobufOverhead];

adc_channel_t channels[] = {adc_channel_t(ADC1_GPIO34_CHANNEL)};
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

adc_continuous_handle_t initialize_adc()
{
    adc_continuous_handle_t handle = nullptr;
    adc_continuous_handle_cfg_t handle_config = {};
    handle_config.max_store_buf_size = kAdcBufferSize * 4;
    handle_config.conv_frame_size = kAdcBufferSize;
    ESP_ERROR_CHECK(adc_continuous_new_handle(&handle_config, &handle));

    adc_digi_pattern_config_t pattern[1] = {};
    pattern[0].atten = ADC_ATTEN_DB_12;
    pattern[0].channel = channels[0] & 0x7;
    pattern[0].unit = ADC_UNIT_1;
    pattern[0].bit_width = SOC_ADC_DIGI_MAX_BITWIDTH;

    const adc_continuous_config_t config = {
        .pattern_num = 1,
        .adc_pattern = pattern,
        .sample_freq_hz = CONFIG_SCOPE_SAMPLE_RATE_HZ,
        .conv_mode = ADC_CONV_SINGLE_UNIT_1,
        .format = ADC_DIGI_OUTPUT_FORMAT_TYPE1,
    };
    ESP_ERROR_CHECK(adc_continuous_config(handle, &config));
    return handle;
}
} // namespace

[[noreturn]] void scope::AdcStream::run() noexcept
{
    ESP_ERROR_CHECK(sink_.send == nullptr ? ESP_ERR_INVALID_ARG : ESP_OK);
    adc_continuous_handle_t handle = initialize_adc();
    ESP_ERROR_CHECK(adc_continuous_start(handle));

    while (true) {
        uint32_t bytes_read = 0;
        const esp_err_t result = adc_continuous_read(
            handle, adc_data, sizeof(adc_data), &bytes_read, portMAX_DELAY);

        if (result == ESP_OK) {
            size_t offset = 0;
            protobuf_message[offset++] = 0x0a; // field 1: adcData (bytes)
            offset += encode_varint(bytes_read, protobuf_message + offset);
            std::memcpy(protobuf_message + offset, adc_data, bytes_read);
            offset += bytes_read;
            protobuf_message[offset++] = 0x10; // field 2: numberOfData (int32)
            offset += encode_varint(bytes_read / sizeof(adc_digi_output_data_t),
                                    protobuf_message + offset);
            sink_.send(sink_.context, protobuf_message, offset);
        } else if (result != ESP_ERR_TIMEOUT) {
            ESP_LOGE(tag, "ADC read failed: %s", esp_err_to_name(result));
        }
    }
}

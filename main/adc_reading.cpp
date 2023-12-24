/*
 * SPDX-FileCopyrightText: 2021-2022 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <string.h>
#include <stdio.h>
#include "sdkconfig.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_adc/adc_continuous.h"
#include "soc/adc_channel.h"
#include "driver/uart.h"

#include "single_include/nlohmann/json.hpp"

#include <pb_encode.h>
#include <pb_decode.h>
#include "wsInterface.pb.h"

#define _EXAMPLE_ADC_UNIT_STR(unit) #unit
#define EXAMPLE_ADC_UNIT_STR(unit) _EXAMPLE_ADC_UNIT_STR(unit)

static adc_channel_t channel[] = {adc_channel_t(ADC1_GPIO34_CHANNEL)};

size_t nmbOfSmp = sizeof(AdcDataTest3::adcData.bytes) / 2;
size_t ReadLen = nmbOfSmp * 2;//ReadLen in bytes
adc_unit_t AdcUnit = ADC_UNIT_1;
adc_atten_t AdcAtten = ADC_ATTEN_DB_11;

static TaskHandle_t s_task_handle;
static const char *TAG = __FILE__;

void sendWsData2Clients(const void *data, const size_t size_of_data);

static bool IRAM_ATTR s_conv_done_cb(adc_continuous_handle_t handle, const adc_continuous_evt_data_t *edata, void *user_data)
{
    BaseType_t mustYield = pdFALSE;
    // Notify that ADC continuous driver has done enough number of conversions
    vTaskNotifyGiveFromISR(s_task_handle, &mustYield);

    return (mustYield == pdTRUE);
}

static void continuous_adc_init(adc_channel_t *channel, uint8_t channel_num, adc_continuous_handle_t *out_handle)
{
    adc_continuous_handle_t handle = NULL;

    adc_continuous_handle_cfg_t adc_config = {
        .max_store_buf_size = ReadLen,
        .conv_frame_size = ReadLen,
    };
    ESP_ERROR_CHECK(adc_continuous_new_handle(&adc_config, &handle));

    adc_continuous_config_t dig_cfg = {
        .sample_freq_hz = 100 * 1000,
        .conv_mode = ADC_CONV_SINGLE_UNIT_1,
        .format = ADC_DIGI_OUTPUT_FORMAT_TYPE1,
    };

    adc_digi_pattern_config_t adc_pattern[SOC_ADC_PATT_LEN_MAX] = {0};
    dig_cfg.pattern_num = channel_num;
    for (int i = 0; i < channel_num; i++)
    {
        adc_pattern[i].atten = ADC_ATTEN_DB_11;
        adc_pattern[i].channel = channel[i] & 0x7;
        adc_pattern[i].unit = AdcUnit;
        adc_pattern[i].bit_width = SOC_ADC_DIGI_MAX_BITWIDTH;

        ESP_LOGI(TAG, "adc_pattern[%d].atten is :%" PRIx8, i, adc_pattern[i].atten);
        ESP_LOGI(TAG, "adc_pattern[%d].channel is :%" PRIx8, i, adc_pattern[i].channel);
        ESP_LOGI(TAG, "adc_pattern[%d].unit is :%" PRIx8, i, adc_pattern[i].unit);
    }
    dig_cfg.adc_pattern = adc_pattern;
    ESP_ERROR_CHECK(adc_continuous_config(handle, &dig_cfg));

    *out_handle = handle;
}

void adc_task_json_data_sender(void)
{
    using json = nlohmann::json;
    using namespace std;
    json test;

    std::vector<uint16_t> data_to_send(ReadLen / sizeof(adc_digi_output_data_t));

    esp_err_t ret;
    uint32_t ret_num = 0;
    uint8_t result[ReadLen] = {0};
    memset(result, 0xcc, ReadLen);

    s_task_handle = xTaskGetCurrentTaskHandle();

    adc_continuous_handle_t handle = NULL;
    continuous_adc_init(channel, sizeof(channel) / sizeof(adc_channel_t), &handle);

    adc_continuous_evt_cbs_t cbs = {
        .on_conv_done = s_conv_done_cb,
    };
    ESP_ERROR_CHECK(adc_continuous_register_event_callbacks(handle, &cbs, NULL));
    ESP_ERROR_CHECK(adc_continuous_start(handle));

    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

    while (1)
    {
        ret = adc_continuous_read(handle, result, ReadLen, &ret_num, portMAX_DELAY);
        if (ret == ESP_OK)
        {
            // printf("readed %lu \r\n", ret_num);
            adc_digi_output_data_t *p = reinterpret_cast<adc_digi_output_data_t *>(result);
            for (int i = 0; i < ret_num / sizeof(adc_digi_output_data_t); i++)
            {
                uint32_t chan_num = (p + i)->type1.channel;
                uint32_t data = (p + i)->type1.data;
                /* Check the channel number validation, the data is invalid if the channel num exceed the maximum channel */
                if (chan_num < SOC_ADC_CHANNEL_NUM(AdcUnit))
                {
                    data_to_send[i] = data;
                }
            }
            test["Ch1Data"] = data_to_send;
            string data = test.dump();
            uint32_t len = data.size();
            sendWsData2Clients(data.c_str(), len);
            vTaskDelay(1);
        }
        else if (ret == ESP_ERR_TIMEOUT)
        {
            // We try to read `EXAMPLE_READ_LEN` until API returns timeout, which means there's no available data
            break;
        }
    }

    ESP_ERROR_CHECK(adc_continuous_stop(handle));
    ESP_ERROR_CHECK(adc_continuous_deinit(handle));
}

void adc_task_protobuf_uint32_data_sender(void)
{
    using namespace std;

    esp_err_t ret;
    uint32_t ret_num = 0;
    uint8_t result[ReadLen] = {0};
    memset(result, 0xcc, ReadLen);

    const size_t protobuf_buffer_size = 768;
    uint8_t protobuf_buffer[protobuf_buffer_size];

    s_task_handle = xTaskGetCurrentTaskHandle();

    adc_continuous_handle_t handle = NULL;
    continuous_adc_init(channel, sizeof(channel) / sizeof(adc_channel_t), &handle);

    adc_continuous_evt_cbs_t cbs = {
        .on_conv_done = s_conv_done_cb,
    };

    ESP_ERROR_CHECK(adc_continuous_register_event_callbacks(handle, &cbs, NULL));
    ESP_ERROR_CHECK(adc_continuous_start(handle));

    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

    while (1)
    {
        AdcDataTest2 proto_message = AdcDataTest2_init_zero;

        ret = adc_continuous_read(handle, result, ReadLen, &ret_num, portMAX_DELAY);
        if (ret == ESP_OK)
        {
            // printf("readed %lu \r\n", ret_num);
            adc_digi_output_data_t *p = reinterpret_cast<adc_digi_output_data_t *>(result);
            for (int i = 0; i < ret_num / sizeof(adc_digi_output_data_t); i++)
            {
                uint32_t chan_num = (p + i)->type1.channel;
                uint32_t data = (p + i)->type1.data;
                /* Check the channel number validation, the data is invalid if the channel num exceed the maximum channel */
                if (chan_num < SOC_ADC_CHANNEL_NUM(AdcUnit))
                {
                    proto_message.index[i] = data;
                }
            }
            proto_message.index_count = ret_num / sizeof(adc_digi_output_data_t);
            pb_ostream_t stream = pb_ostream_from_buffer(protobuf_buffer, sizeof(protobuf_buffer));

            bool status = pb_encode(&stream, AdcDataTest2_fields, &proto_message);
            size_t message_length = stream.bytes_written;

            sendWsData2Clients(protobuf_buffer, message_length);
            // vTaskDelay(1);
        }
        else if (ret == ESP_ERR_TIMEOUT)
        {
            // We try to read `EXAMPLE_READ_LEN` until API returns timeout, which means there's no available data
            break;
        }
    }

    ESP_ERROR_CHECK(adc_continuous_stop(handle));
    ESP_ERROR_CHECK(adc_continuous_deinit(handle));
}

void adc_task_protobuf_bytes_data_sender(void)
{
    using namespace std;

    const size_t protobuf_buffer_size = sizeof(AdcDataTest3) * 1.5;
    uint8_t protobuf_buffer[protobuf_buffer_size];

    s_task_handle = xTaskGetCurrentTaskHandle();

    adc_continuous_handle_t handle = NULL;
    continuous_adc_init(channel, sizeof(channel) / sizeof(adc_channel_t), &handle);

    adc_continuous_evt_cbs_t cbs = {
        .on_conv_done = s_conv_done_cb,
    };

    ESP_ERROR_CHECK(adc_continuous_register_event_callbacks(handle, &cbs, NULL));
    ESP_ERROR_CHECK(adc_continuous_start(handle));

    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

    while (1)
    {
        uint32_t ret_num = 0;
        AdcDataTest3 proto_message = AdcDataTest3_init_zero;

        esp_err_t ret = adc_continuous_read(handle, proto_message.adcData.bytes, ReadLen, &ret_num, portMAX_DELAY);


        if (ret == ESP_OK)
        {
            proto_message.adcData.size = ret_num;
            proto_message.numberOfdata = ret_num / sizeof(adc_digi_output_data_t);

            pb_ostream_t stream = pb_ostream_from_buffer(protobuf_buffer, sizeof(protobuf_buffer));

            bool status = pb_encode(&stream, AdcDataTest3_fields, &proto_message);
            size_t message_length = stream.bytes_written;

            sendWsData2Clients(protobuf_buffer, message_length);
            // vTaskDelay(1);
        }
        else if (ret == ESP_ERR_TIMEOUT)
        {
            break;
        }
    }

    ESP_ERROR_CHECK(adc_continuous_stop(handle));
    ESP_ERROR_CHECK(adc_continuous_deinit(handle));
}
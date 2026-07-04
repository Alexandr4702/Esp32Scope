# Esp32Scope

ESP32 oscilloscope experiment with continuous ADC sampling and protobuf transport over WebSocket.

## Architecture

- `main.cpp` initializes ESP-IDF services and wires the modules together.
- `AdcStream` owns continuous ADC acquisition and emits encoded frames through
  a `DataSink` callback. It has no Wi-Fi or HTTP dependency.
- `WifiStation` owns station configuration, reconnects, and reports connection
  state through callbacks. It has no web-server dependency.
- `WebServer` owns its HTTP handle, mutex, static UI routes, WebSocket clients,
  and frame broadcast.
- `webPage` is the browser UI and keeps samples in a fixed-size ring buffer.

The normal data path is:

```text
ADC DMA -> adc_stream -> DataSink -> web_server -> WebSocket -> browser ring buffer
```

Build in an initialized ESP-IDF environment:

```powershell
idf.py build
```

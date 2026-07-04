# Esp32Scope

Esp32Scope turns an ESP32-WROOM-32D into a small Wi-Fi oscilloscope for
observing low-voltage signals in a browser. The firmware continuously samples
GPIO34 with ADC1, sends the samples over a WebSocket, and serves the complete
web interface directly from the ESP32.

This project is useful for visualizing slow digital signals, sensor outputs,
PWM envelopes, and other low-frequency waveforms when a laboratory
oscilloscope is not required. It is an experimental measurement tool, not a
replacement for an isolated and calibrated oscilloscope.

## What it does

- Samples ADC1 on GPIO34 at 200 kSa/s by default.
- Streams raw 12-bit ADC readings over Wi-Fi without an external server.
- Displays the waveform, measured sample rate, minimum, maximum, and visible
  time window in a responsive browser UI.
- Supports pause, clear, horizontal zoom, and automatic or full vertical scale.
- Reconnects Wi-Fi and the browser WebSocket automatically.
- Runs acquisition on CPU core 1 while the ESP-IDF Wi-Fi task uses core 0.

The displayed values are raw ADC codes from 0 to 4095. The firmware does not
currently convert them to calibrated volts and does not implement triggering,
AC coupling, input attenuation, or galvanic isolation.

## Hardware and signal connection

The tested target is an ESP32-WROOM-32D module with 4 MB flash.

| Signal | ESP32 pin |
| --- | --- |
| Analog input | GPIO34 / ADC1 |
| Signal ground | GND |

GPIO34 is input-only, which makes it suitable for this ADC channel. Connect the
signal ground to ESP32 ground and keep the input within the electrical limits
of the board. Use an appropriate divider, buffer, and protection circuit before
measuring signals that can exceed those limits. Never connect mains or another
high-energy source directly to the ESP32.

## Requirements

- ESP32-WROOM-32D or a compatible classic ESP32 board
- ESP-IDF 6.0.2
- Python environment installed by ESP-IDF
- USB-to-UART connection for flashing
- A 2.4 GHz Wi-Fi network and a browser on the same network

No Node.js build is required. HTML, CSS, and JavaScript are embedded into the
firmware by CMake.

## Configuration

Open the project configuration menu:

```powershell
idf.py menuconfig
```

Under `ESP32 Scope`, configure:

- `Wi-Fi SSID`
- `Wi-Fi password`
- `ADC sample rate` — 200000 samples/second by default

The accepted sample-rate range is 20 kSa/s to 1 MSa/s. Higher values increase
Wi-Fi traffic, CPU load, ADC noise, and the chance of dropped samples. The
200 kSa/s default is the balanced operating point used by this repository.

Credentials are stored in the generated `sdkconfig`. Do not publish a
configuration containing a real Wi-Fi password.

## Build, flash, and monitor

Run the commands from an initialized ESP-IDF terminal:

```powershell
idf.py set-target esp32
idf.py build
idf.py -p COM5 -b 115200 flash monitor
```

Replace `COM5` with the port assigned to your USB-to-UART adapter. A conservative
115200 baud flash speed is shown because it is more tolerant of noisy serial
connections. Once flashing is reliable, a higher baud rate can be tried.

The custom partition table provides a 2 MB factory application partition. The
current firmware image occupies about 850 KB.

## Using the scope

1. Flash the firmware and open the serial monitor.
2. Wait for `IP address acquired` and note the address assigned by the router.
3. Open `http://<esp32-ip>/` from a device on the same network.
4. Connect the protected signal to GPIO34 and GND.
5. Use the slider or mouse wheel over the graph to change the visible history.

The sample-rate indicator reports the rate received by the browser. If it is
substantially below the configured rate, check Wi-Fi signal quality and reduce
the configured ADC rate.

## Libraries and ESP-IDF components

The runtime uses only components supplied with ESP-IDF:

| Component | Purpose |
| --- | --- |
| `esp_adc` | Continuous ADC/DMA acquisition |
| `esp_wifi` | Wi-Fi station mode |
| `esp_netif` | TCP/IP network interface |
| `esp_event` | Wi-Fi and IP event delivery |
| `esp_http_server` | Static files and WebSocket transport |
| `freertos` | ADC task and synchronization |
| `nvs_flash` | Wi-Fi/PHY persistent storage |

The browser side uses the native Canvas 2D and WebSocket APIs. There are no
external JavaScript libraries or CDN dependencies in the active UI.

## Data protocol

Each binary WebSocket frame contains a compact protobuf-compatible message:

- field 1: ADC DMA bytes
- field 2: number of samples

On classic ESP32 each DMA result occupies two bytes. The browser extracts the
12-bit ADC value and stores it in a fixed-size `Uint16Array` ring buffer to avoid
reallocating and shifting the history for every packet.

## Architecture

```text
GPIO34 -> ADC DMA -> AdcStream -> DataSink -> WebServer
                                               |
                                               v
Browser UI <- WebSocket <- HTTP server <- Wi-Fi station
```

- `Application` initializes ESP-IDF and owns the application services.
- `AdcStream` owns continuous acquisition and emits encoded frames through a
  typed sink callback without depending on HTTP or Wi-Fi.
- `WifiStation` owns station configuration and translates ESP-IDF events into
  connection callbacks.
- `WebServer` owns its HTTP handle and mutex, serves embedded assets, and
  broadcasts frames to connected WebSocket clients.

The static adapters around ESP-IDF callbacks are deliberately thin. Mutable
state remains inside the owning C++ objects.

## Project layout

```text
main/
  main.cpp             Application composition and startup
  adc_stream.*         ADC acquisition and frame encoding
  wifi_station.*       Wi-Fi lifecycle
  web_server.*         HTTP/WebSocket server
  webPage/             Embedded browser UI
  Kconfig.projbuild    Project configuration options
partitions.csv         Flash partition table
sdkconfig.defaults     Reproducible ESP32 defaults
```

## Recent commits

| Commit | Change |
| --- | --- |
| `2852e47` | Configures the ESP-IDF 6 development environment and editor tooling. |
| `e5a1470` | Modernizes the firmware, introduces the C++ service architecture, and raises acquisition performance. |
| `456bbe5` | Adds the responsive English oscilloscope UI and browser-side ring buffer. |

## Current limitations

- One ADC channel only
- No hardware or software trigger
- No calibrated voltage scale
- No sample timestamps or dropped-frame counter
- Wi-Fi throughput affects the delivered sample rate
- ESP32 ADC linearity and noise limit measurement accuracy

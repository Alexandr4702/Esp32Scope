# Esp32Scope

Esp32Scope turns an ESP32-WROOM-32D into a small browser-based oscilloscope.
It continuously samples GPIO34 through ADC1, losslessly bit-packs 9- to 12-bit
samples for streaming over WebSocket, and serves the web interface directly
from the ESP32.

The interface displays the waveform, sample rate, minimum and maximum values,
and supports pause, clear, time-based horizontal zoom, selectable ADC1 input,
resolution and attenuation, and automatic or full vertical scale. This is an
experimental tool for low-voltage signals, not an isolated
or calibrated laboratory oscilloscope.

## Build and flash

Requirements:

- ESP32-WROOM-32D or compatible classic ESP32 board
- ESP-IDF 6.0.2
- 2.4 GHz Wi-Fi network

Configure the project:

```powershell
idf.py menuconfig
```

Under `ESP32 Scope`, set the Wi-Fi SSID, password, optional local hostname,
and ADC sample rate. The default hostname is `esp32scope` and the default
sample rate is 200000 samples/second.

Build and flash:

```powershell
idf.py set-target esp32
idf.py build
idf.py -p COM5 -b 115200 flash monitor
```

Replace `COM5` with the board's serial port. After the ESP32 receives an IP
address, open `http://esp32scope.local/`. If mDNS is unavailable, open the IP
address printed by the serial monitor.

Connect the measured low-voltage signal to GPIO34 and its ground to ESP32 GND.
Use an appropriate divider, buffer, and protection circuit when necessary.
Never connect mains or another high-energy source directly to the ESP32.

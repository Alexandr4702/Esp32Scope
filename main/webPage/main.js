const $ = id => document.getElementById(id);
const canvas = $("scope");
const context = canvas.getContext("2d", { alpha: false });
const historySlider = $("history-size");
const historyValue = $("history-size-value");
const connection = $("connection");
const pauseButton = $("pause");
const verticalScale = $("vertical-scale");
const sampleRateControl = $("sample-rate-control");
const bitWidthControl = $("bit-width");
const adcPinControl = $("adc-pin");
const attenuationControl = $("adc-attenuation");

const sampleCapacity = Number(historySlider.max);
const samples = new Uint16Array(sampleCapacity);
let sampleStart = 0;
let sampleCount = 0;
let maxDataPoints = Number(historySlider.value);
let socket = null;
let reconnectTimer = null;
let reconnectDelay = 500;
let paused = false;
let drawPending = false;
let rateCounter = 0;
let measuredRate = 0;
let rateStartedAt = performance.now();
let adcMaximum = 4095;

function setStatus(mode, label) {
    connection.className = `status status-${mode}`;
    connection.querySelector("strong").textContent = label;
}

function readVarint(bytes, cursor) {
    let value = 0;
    let shift = 0;
    while (cursor.offset < bytes.length && shift < 35) {
        const byte = bytes[cursor.offset++];
        value += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) return value;
        shift += 7;
    }
    throw new Error("Invalid protobuf varint");
}

function decodeAdcData(message) {
    const cursor = { offset: 0 };
    while (cursor.offset < message.length) {
        const tag = readVarint(message, cursor);
        const field = Math.floor(tag / 8);
        const wireType = tag & 7;
        if (field === 1 && wireType === 2) {
            const length = readVarint(message, cursor);
            const end = cursor.offset + length;
            if (end > message.length) throw new Error("Truncated ADC payload");
            return message.subarray(cursor.offset, end);
        }
        if (wireType === 0) readVarint(message, cursor);
        else if (wireType === 1) cursor.offset += 8;
        else if (wireType === 2) cursor.offset += readVarint(message, cursor);
        else if (wireType === 5) cursor.offset += 4;
        else throw new Error(`Unsupported protobuf wire type ${wireType}`);
        if (cursor.offset > message.length) throw new Error("Truncated protobuf packet");
    }
    throw new Error("ADC data is missing from the packet");
}

function connect() {
    clearTimeout(reconnectTimer);
    setStatus("offline", "Connecting…");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", () => {
        reconnectDelay = 500;
        setStatus(paused ? "paused" : "online", paused ? "Paused" : "Connected");
        socket.send("get_rate");
        socket.send("get_bits");
        socket.send("get_pin");
        socket.send("get_atten");
    });
    socket.addEventListener("message", event => {
        try {
            if (typeof event.data === "string") {
                if (event.data.startsWith("rate:")) {
                    const rate = Number(event.data.slice(5));
                    sampleRateControl.value = String(rate);
                    measuredRate = rate;
                    $("sample-rate").textContent = rate.toLocaleString("en-US");
                    updateWindowTime();
                } else if (event.data.startsWith("bits:")) {
                    const bits = Number(event.data.slice(5));
                    bitWidthControl.value = String(bits);
                    adcMaximum = 2 ** bits - 1;
                    $("full-scale-option").textContent = `Full scale (0–${adcMaximum})`;
                    scheduleDraw();
                } else if (event.data.startsWith("pin:")) {
                    adcPinControl.value = event.data.slice(4);
                    $("input-pin-label").textContent = `GPIO${adcPinControl.value}`;
                } else if (event.data.startsWith("atten:")) {
                    attenuationControl.value = event.data.slice(6);
                }
                return;
            }
            const packet = decodeAdcData(new Uint8Array(event.data));
            const decoded = unpackSamples(packet);
            rateCounter += decoded.length;
            if (!paused) {
                appendSamples(decoded);
                scheduleDraw();
            }
            updateRate();
        } catch (error) {
            console.error("Failed to decode ADC packet", error);
        }
    });
    socket.addEventListener("close", () => {
        setStatus("offline", "Disconnected");
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    });
    socket.addEventListener("error", () => socket.close());
}

function unpackSamples(packet) {
    if (packet.length < 4 || packet[0] !== 0xa5) {
        throw new Error("Unsupported ADC packet format");
    }
    const bits = packet[1];
    const count = packet[2] | (packet[3] << 8);
    if (bits < 9 || bits > 12 || packet.length < 4 + Math.ceil(count * bits / 8)) {
        throw new Error("Invalid packed ADC payload");
    }
    const result = new Uint16Array(count);
    const mask = 2 ** bits - 1;
    let accumulator = 0;
    let accumulatedBits = 0;
    let offset = 4;
    for (let i = 0; i < count; i++) {
        while (accumulatedBits < bits) {
            accumulator += packet[offset++] * 2 ** accumulatedBits;
            accumulatedBits += 8;
        }
        result[i] = accumulator & mask;
        accumulator = Math.floor(accumulator / 2 ** bits);
        accumulatedBits -= bits;
    }
    return result;
}

function appendSamples(values) {
    for (const value of values) {
        if (sampleCount < maxDataPoints) {
            samples[(sampleStart + sampleCount++) % sampleCapacity] = value;
        } else {
            samples[sampleStart] = value;
            sampleStart = (sampleStart + 1) % sampleCapacity;
        }
    }
}

function sampleAt(index) {
    return samples[(sampleStart + index) % sampleCapacity];
}

function trimSamples() {
    if (sampleCount <= maxDataPoints) return;
    sampleStart = (sampleStart + sampleCount - maxDataPoints) % sampleCapacity;
    sampleCount = maxDataPoints;
}

function updateRate() {
    const now = performance.now();
    const elapsed = now - rateStartedAt;
    if (elapsed < 500) return;
    measuredRate = Math.round(rateCounter * 1000 / elapsed);
    rateCounter = 0;
    rateStartedAt = now;
    $("sample-rate").textContent = measuredRate.toLocaleString("en-US");
    updateWindowTime();
}

function updateWindowTime() {
    if (!measuredRate) {
        $("window-time").textContent = "—";
        historyValue.textContent = "—";
        return;
    }
    const seconds = maxDataPoints / measuredRate;
    const [value, unit] = seconds >= 1 ? [seconds, "s"]
        : seconds >= 0.001 ? [seconds * 1000, "ms"] : [seconds * 1000000, "µs"];
    const text = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
    $("window-time").textContent = text;
    $("window-time-unit").textContent = unit;
    historyValue.textContent = `${text} ${unit}`;
}

function resizeCanvas() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
    return ratio;
}

function drawGrid(width, height, ratio, yMinimum, yMaximum) {
    const left = 48 * ratio;
    const bottom = 24 * ratio;
    const plotWidth = width - left;
    const plotHeight = height - bottom;
    context.fillStyle = "#090e15";
    context.fillRect(0, 0, width, height);
    context.lineWidth = 1;
    context.strokeStyle = "#182330";
    context.beginPath();
    for (let i = 0; i <= 10; i++) {
        const x = left + plotWidth * i / 10;
        context.moveTo(x, 0); context.lineTo(x, plotHeight);
    }
    for (let i = 0; i <= 4; i++) {
        const y = plotHeight * i / 4;
        context.moveTo(left, y); context.lineTo(width, y);
    }
    context.stroke();

    context.fillStyle = "#60738b";
    context.font = `${10 * ratio}px ui-monospace, monospace`;
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (let index = 0; index <= 4; index++) {
        const value = Math.round(yMaximum - (yMaximum - yMinimum) * index / 4);
        context.fillText(String(value), left - 7 * ratio, plotHeight * index / 4);
    }
    return { left, plotWidth, plotHeight };
}

function draw() {
    drawPending = false;
    const ratio = resizeCanvas();
    let minimum = adcMaximum;
    let maximum = 0;
    for (let i = 0; i < sampleCount; i++) {
        const value = sampleAt(i);
        if (value < minimum) minimum = value;
        if (value > maximum) maximum = value;
    }
    let yMinimum = 0;
    let yMaximum = adcMaximum;
    if (verticalScale.value === "auto" && sampleCount) {
        const padding = Math.max(32, Math.round((maximum - minimum) * 0.1));
        yMinimum = Math.max(0, minimum - padding);
        yMaximum = Math.min(adcMaximum, maximum + padding);
        if (yMaximum - yMinimum < 64) {
            const center = (yMinimum + yMaximum) / 2;
            yMinimum = Math.max(0, Math.floor(center - 32));
            yMaximum = Math.min(adcMaximum, Math.ceil(center + 32));
        }
    }
    const { left, plotWidth, plotHeight } = drawGrid(canvas.width, canvas.height, ratio, yMinimum, yMaximum);
    if (sampleCount < 2) return;

    context.strokeStyle = "#39d98a";
    context.lineWidth = Math.max(1, ratio);
    context.beginPath();
    const columns = Math.max(1, Math.floor(plotWidth));
    const groupSize = Math.max(1, Math.ceil(sampleCount / columns));
    if (groupSize === 1) {
        const xScale = plotWidth / (sampleCount - 1);
        for (let index = 0; index < sampleCount; index++) {
            const value = sampleAt(index);
            const x = left + index * xScale;
            const y = plotHeight - (value - yMinimum) * plotHeight / (yMaximum - yMinimum);
            if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
        }
    } else {
        for (let start = 0, column = 0; start < sampleCount; start += groupSize, column++) {
            let low = adcMaximum, high = 0;
            const end = Math.min(start + groupSize, sampleCount);
            for (let i = start; i < end; i++) {
                const value = sampleAt(i);
                if (value < low) low = value;
                if (value > high) high = value;
            }
            const x = left + column * plotWidth / Math.ceil(sampleCount / groupSize);
            context.moveTo(x, plotHeight - (low - yMinimum) * plotHeight / (yMaximum - yMinimum));
            context.lineTo(x, plotHeight - (high - yMinimum) * plotHeight / (yMaximum - yMinimum));
        }
    }
    context.stroke();
}

function scheduleDraw() {
    if (!drawPending) {
        drawPending = true;
        requestAnimationFrame(draw);
    }
}

historySlider.addEventListener("input", () => {
    maxDataPoints = Number(historySlider.value);
    trimSamples();
    updateWindowTime();
    scheduleDraw();
});
pauseButton.addEventListener("click", () => {
    paused = !paused;
    pauseButton.textContent = paused ? "Resume" : "Pause";
    setStatus(paused ? "paused" : (socket?.readyState === WebSocket.OPEN ? "online" : "offline"),
        paused ? "Paused" : (socket?.readyState === WebSocket.OPEN ? "Connected" : "Disconnected"));
});
$("clear").addEventListener("click", () => {
    sampleStart = 0;
    sampleCount = 0;
    scheduleDraw();
});
window.addEventListener("resize", scheduleDraw);
verticalScale.addEventListener("change", scheduleDraw);
sampleRateControl.addEventListener("change", () => {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(`rate:${sampleRateControl.value}`);
    }
});
bitWidthControl.addEventListener("change", () => {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(`bits:${bitWidthControl.value}`);
    }
});
adcPinControl.addEventListener("change", () => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(`pin:${adcPinControl.value}`);
});
attenuationControl.addEventListener("change", () => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(`atten:${attenuationControl.value}`);
});
canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const direction = event.deltaY > 0 ? 1 : -1;
    const next = Math.max(Number(historySlider.min), Math.min(Number(historySlider.max),
        Number(historySlider.value) + direction * Number(historySlider.step)));
    historySlider.value = String(next);
    historySlider.dispatchEvent(new Event("input"));
}, { passive: false });
historySlider.dispatchEvent(new Event("input"));
connect();
scheduleDraw();

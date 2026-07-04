const $ = id => document.getElementById(id);
const canvas = $("scope");
const context = canvas.getContext("2d", { alpha: false });
const historySlider = $("history-size");
const historyValue = $("history-size-value");
const connection = $("connection");
const pauseButton = $("pause");
const verticalScale = $("vertical-scale");
const sampleRateControl = $("sample-rate-control");
const channelInputs = [...document.querySelectorAll("#channel-picker input")];
const bitWidthControls = [...document.querySelectorAll("#channel-picker select")];
const attenuationControl = $("adc-attenuation");

const sampleCapacity = Number(historySlider.max);
const samples = Array.from({ length: 6 }, () => new Uint16Array(sampleCapacity));
const sampleStarts = Array(6).fill(0);
const sampleCounts = Array(6).fill(0);
let activeChannelCount = 1;
let activeGpios = [34];
let activeBitWidths = [12];
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
        socket.send("get_channels");
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
                    applyBitWidths(Number(event.data.slice(5)));
                    scheduleDraw();
                } else if (event.data.startsWith("channels:")) {
                    applyChannelMask(Number(event.data.slice(9)));
                } else if (event.data.startsWith("atten:")) {
                    attenuationControl.value = event.data.slice(6);
                }
                return;
            }
            const packet = decodeAdcData(new Uint8Array(event.data));
            const decoded = unpackSamples(packet);
            rateCounter += decoded.totalCount;
            if (!paused) {
                activeChannelCount = decoded.channels.length;
                decoded.channels.forEach((values, channel) => appendSamples(channel, values));
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
    if (packet.length < 17 || packet[0] !== 0xa5) {
        throw new Error("Unsupported ADC packet format");
    }
    const channelCount = packet[1];
    const firstChannel = packet[2];
    const gpios = [...packet.subarray(3, 3 + channelCount)];
    const bitWidths = [...packet.subarray(9, 9 + channelCount)];
    const count = packet[15] | (packet[16] << 8);
    if (channelCount < 1 || channelCount > 6 || firstChannel >= channelCount ||
        bitWidths.some(bits => bits < 9 || bits > 12)) {
        throw new Error("Invalid packed ADC payload");
    }
    const channels = Array.from({ length: channelCount }, () =>
        new Uint16Array(Math.ceil(count / channelCount)));
    const positions = new Uint32Array(channelCount);
    let accumulator = 0;
    let accumulatedBits = 0;
    let offset = 17;
    let channel = firstChannel;
    for (let i = 0; i < count; i++) {
        const bits = bitWidths[channel];
        while (accumulatedBits < bits) {
            if (offset >= packet.length) throw new Error("Truncated packed ADC payload");
            accumulator += packet[offset++] * 2 ** accumulatedBits;
            accumulatedBits += 8;
        }
        channels[channel][positions[channel]++] = accumulator & (2 ** bits - 1);
        accumulator = Math.floor(accumulator / 2 ** bits);
        accumulatedBits -= bits;
        if (++channel === channelCount) channel = 0;
    }
    if (gpios.join() !== activeGpios.join() || bitWidths.join() !== activeBitWidths.join()) {
        sampleStarts.fill(0);
        sampleCounts.fill(0);
    }
    activeGpios = gpios;
    activeBitWidths = bitWidths;
    adcMaximum = Math.max(...bitWidths.map(bits => 2 ** bits - 1));
    $("full-scale-option").textContent = `Full scale (0–${adcMaximum})`;
    updateChannelLegend();
    return { channels: channels.map((values, channel) => values.subarray(0, positions[channel])),
        totalCount: count };
}

const channelColors = ["#39d98a", "#ffb347", "#5da9ff", "#d875ff", "#ff6b7a", "#66e0e5"];

function updateChannelLegend() {
    $("channel-legend").innerHTML = activeGpios.map((gpio, index) =>
        `<span style="--channel-color:${channelColors[index]}">GPIO${gpio}</span>`).join("");
    $("input-pin-label").textContent = activeGpios.map(gpio => `GPIO${gpio}`).join("/");
}

function applyChannelMask(mask) {
    channelInputs.forEach((input, index) => input.checked = (mask & (1 << index)) !== 0);
}

function applyBitWidths(value) {
    bitWidthControls.forEach((control, index) =>
        control.value = String(9 + ((value >> (index * 2)) & 3)));
}

function sendBitWidths() {
    const value = bitWidthControls.reduce((packed, control, index) =>
        packed | ((Number(control.value) - 9) << (index * 2)), 0);
    if (socket?.readyState === WebSocket.OPEN) socket.send(`bits:${value}`);
}

function sendChannelMask(changedInput) {
    let mask = channelInputs.reduce((value, input, index) =>
        value | (input.checked ? 1 << index : 0), 0);
    if (mask === 0) {
        changedInput.checked = true;
        mask = 1 << channelInputs.indexOf(changedInput);
    }
    if (socket?.readyState === WebSocket.OPEN) socket.send(`channels:${mask}`);
}

function appendSamples(channel, values) {
    for (const value of values) {
        if (sampleCounts[channel] < maxDataPoints) {
            samples[channel][(sampleStarts[channel] + sampleCounts[channel]++) % sampleCapacity] = value;
        } else {
            samples[channel][sampleStarts[channel]] = value;
            sampleStarts[channel] = (sampleStarts[channel] + 1) % sampleCapacity;
        }
    }
}

function sampleAt(channel, index) {
    return samples[channel][(sampleStarts[channel] + index) % sampleCapacity];
}

function trimSamples() {
    for (let channel = 0; channel < 6; channel++) {
        if (sampleCounts[channel] <= maxDataPoints) continue;
        sampleStarts[channel] = (sampleStarts[channel] + sampleCounts[channel] - maxDataPoints) % sampleCapacity;
        sampleCounts[channel] = maxDataPoints;
    }
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
    const { value, unit } = windowTimeScale();
    const text = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
    $("window-time").textContent = text;
    $("window-time-unit").textContent = unit;
    historyValue.textContent = `${text} ${unit}`;
}

function windowTimeScale() {
    const seconds = maxDataPoints * activeChannelCount / measuredRate;
    if (seconds >= 1) return { value: seconds, unit: "s" };
    if (seconds >= 0.001) return { value: seconds * 1000, unit: "ms" };
    return { value: seconds * 1000000, unit: "µs" };
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
    if (measuredRate) {
        const time = windowTimeScale();
        context.textBaseline = "bottom";
        for (let index = 0; index <= 5; index++) {
            const value = -time.value * (5 - index) / 5;
            context.textAlign = index === 0 ? "left" : index === 5 ? "right" : "center";
            const precision = Math.abs(value) < 10 && value !== 0 ? 1 : 0;
            context.fillText(`${value.toFixed(precision)} ${time.unit}`,
                left + plotWidth * index / 5, height - 3 * ratio);
        }
    }
    return { left, plotWidth, plotHeight };
}

function draw() {
    drawPending = false;
    const ratio = resizeCanvas();
    let minimum = adcMaximum;
    let maximum = 0;
    for (let channel = 0; channel < activeChannelCount; channel++) {
        for (let i = 0; i < sampleCounts[channel]; i++) {
            const value = sampleAt(channel, i);
            if (value < minimum) minimum = value;
            if (value > maximum) maximum = value;
        }
    }
    let yMinimum = 0;
    let yMaximum = adcMaximum;
    if (verticalScale.value === "auto" && sampleCounts.some(count => count > 0)) {
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
    for (let channel = 0; channel < activeChannelCount; channel++) {
        const count = sampleCounts[channel];
        if (count < 2) continue;
        context.strokeStyle = channelColors[channel];
        context.lineWidth = Math.max(1, ratio);
        context.beginPath();
        const columns = Math.max(1, Math.floor(plotWidth));
        const groupSize = Math.max(1, Math.ceil(count / columns));
        if (groupSize === 1) {
            const xScale = plotWidth / (count - 1);
            for (let index = 0; index < count; index++) {
                const value = sampleAt(channel, index);
                const x = left + index * xScale;
                const y = plotHeight - (value - yMinimum) * plotHeight / (yMaximum - yMinimum);
                if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
            }
        } else {
            for (let start = 0, column = 0; start < count; start += groupSize, column++) {
                let low = adcMaximum, high = 0;
                const end = Math.min(start + groupSize, count);
                for (let i = start; i < end; i++) {
                    const value = sampleAt(channel, i);
                    if (value < low) low = value;
                    if (value > high) high = value;
                }
                const x = left + column * plotWidth / Math.ceil(count / groupSize);
                context.moveTo(x, plotHeight - (low - yMinimum) * plotHeight / (yMaximum - yMinimum));
                context.lineTo(x, plotHeight - (high - yMinimum) * plotHeight / (yMaximum - yMinimum));
            }
        }
        context.stroke();
    }
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
    sampleStarts.fill(0);
    sampleCounts.fill(0);
    scheduleDraw();
});
window.addEventListener("resize", scheduleDraw);
verticalScale.addEventListener("change", scheduleDraw);
sampleRateControl.addEventListener("change", () => {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(`rate:${sampleRateControl.value}`);
    }
});
bitWidthControls.forEach(control => control.addEventListener("change", sendBitWidths));
channelInputs.forEach(input => input.addEventListener("change", () => sendChannelMask(input)));
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
updateChannelLegend();
scheduleDraw();

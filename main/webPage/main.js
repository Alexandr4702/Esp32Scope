const $ = id => document.getElementById(id);
const canvas = $("scope");
const context = canvas.getContext("2d", { alpha: false });
const historySlider = $("history-size");
const historyValue = $("history-size-value");
const connection = $("connection");
const pauseButton = $("pause");
const verticalScale = $("vertical-scale");

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
    });
    socket.addEventListener("message", event => {
        try {
            const bytes = decodeAdcData(new Uint8Array(event.data));
            rateCounter += Math.floor(bytes.length / 2);
            if (!paused) {
                appendSamples(bytes);
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

function appendSamples(bytes) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
        const value = (bytes[i] | (bytes[i + 1] << 8)) & 0x0fff;
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
    $("window-time").textContent = measuredRate
        ? (maxDataPoints * 1000 / measuredRate).toFixed(1)
        : "—";
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
    let minimum = 4095;
    let maximum = 0;
    for (let i = 0; i < sampleCount; i++) {
        const value = sampleAt(i);
        if (value < minimum) minimum = value;
        if (value > maximum) maximum = value;
    }
    let yMinimum = 0;
    let yMaximum = 4095;
    if (verticalScale.value === "auto" && sampleCount) {
        const padding = Math.max(32, Math.round((maximum - minimum) * 0.1));
        yMinimum = Math.max(0, minimum - padding);
        yMaximum = Math.min(4095, maximum + padding);
        if (yMaximum - yMinimum < 64) {
            const center = (yMinimum + yMaximum) / 2;
            yMinimum = Math.max(0, Math.floor(center - 32));
            yMaximum = Math.min(4095, Math.ceil(center + 32));
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
            let low = 4095, high = 0;
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
    $("minimum").textContent = minimum.toLocaleString("en-US");
    $("maximum").textContent = maximum.toLocaleString("en-US");
}

function scheduleDraw() {
    if (!drawPending) {
        drawPending = true;
        requestAnimationFrame(draw);
    }
}

historySlider.addEventListener("input", () => {
    maxDataPoints = Number(historySlider.value);
    historyValue.textContent = `${maxDataPoints.toLocaleString("en-US")} samples`;
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
    $("minimum").textContent = "—";
    $("maximum").textContent = "—";
    scheduleDraw();
});
window.addEventListener("resize", scheduleDraw);
verticalScale.addEventListener("change", scheduleDraw);
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

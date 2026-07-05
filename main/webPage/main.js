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
const triggerEnabled = $("trigger-enabled");
const triggerMode = $("trigger-mode");
const triggerSource = $("trigger-source");
const triggerEdge = $("trigger-edge");
const triggerLevel = $("trigger-level");
const triggerPosition = $("trigger-position");
const spectrumCanvas = $("spectrum");
const spectrumContext = spectrumCanvas.getContext("2d", { alpha: false });
const spectrumEnabled = $("spectrum-enabled");
const spectrumSource = $("spectrum-source");
const spectrumMode = $("spectrum-mode");
const spectrumWindow = $("spectrum-window");

// Keep extra history outside the visible window for zooming and pre/post-trigger data.
const sampleCapacity = Number(historySlider.max) * 2;
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
let lastDrawAt = 0;
let rateCounter = 0;
let measuredRate = 0;
let rateStartedAt = performance.now();
let adcMaximum = 4095;
let triggerArmed = true;
let triggeredFrame = null;
let lastRenderedRaw = [];
let triggerGeometry = null;
let triggerDrag = null;
let triggerDragGeometry = null;
const mathChannels = [
    { enabled: false, operation: "subtract", a: 0, b: 1 },
    { enabled: false, operation: "smooth", a: 0, b: 1 }
];
const recordSampleLimit = 1000000;
let recording = null;
let lastRecordStatusAt = 0;

const mathOperations = [
    ["add", "A + B"], ["subtract", "A − B"], ["multiply", "A × B (normalized)"],
    ["divide", "A ÷ B"], ["average", "Average(A, B)"], ["minimum", "Min(A, B)"],
    ["maximum", "Max(A, B)"], ["absolute", "|A|"], ["invert", "Invert A"],
    ["dc", "Remove DC"], ["smooth", "Moving average"], ["derivative", "Derivative"],
    ["integral", "Integral"]
];

function initializeMathControls() {
    $("math-controls").innerHTML = mathChannels.map((channel, index) => `
        <div class="math-row" style="--math-color:${channelColors[6 + index]}">
            <input class="math-enabled" data-index="${index}" type="checkbox" aria-label="Enable M${index + 1}">
            <div><div class="math-name">M${index + 1}</div><div class="math-options">
                <select class="math-operation" data-index="${index}">${mathOperations.map(([value, label]) => `<option value="${value}"${value === channel.operation ? " selected" : ""}>${label}</option>`).join("")}</select>
                <select class="math-a" data-index="${index}"></select><select class="math-b" data-index="${index}"></select>
            </div></div>
        </div>`).join("");
    document.querySelectorAll("#math-controls input, #math-controls select").forEach(control =>
        control.addEventListener("change", updateMathSettings));
    refreshSourceOptions();
}

function refreshSourceOptions() {
    const options = activeGpios.map((gpio, index) => `<option value="${index}">GPIO${gpio}</option>`).join("");
    const previousTrigger = triggerSource.value;
    triggerSource.innerHTML = options;
    triggerSource.value = previousTrigger && Number(previousTrigger) < activeGpios.length ? previousTrigger : "0";
    document.querySelectorAll(".math-a, .math-b").forEach(select => {
        const index = Number(select.dataset.index);
        const previous = select.value;
        select.innerHTML = options;
        const fallback = select.classList.contains("math-b") ? Math.min(1, activeGpios.length - 1) : 0;
        select.value = previous && Number(previous) < activeGpios.length ? previous : String(fallback);
        mathChannels[index][select.classList.contains("math-b") ? "b" : "a"] = Number(select.value);
    });
    const previousSpectrum = spectrumSource.value;
    spectrumSource.innerHTML = activeGpios.map((gpio, index) =>
        `<option value="p${index}">GPIO${gpio}</option>`).join("") +
        mathChannels.flatMap((channel, index) => channel.enabled ?
            [`<option value="m${index}">M${index + 1}</option>`] : []).join("");
    if ([...spectrumSource.options].some(option => option.value === previousSpectrum))
        spectrumSource.value = previousSpectrum;
}

function updateMathSettings(event) {
    const index = Number(event.target.dataset.index);
    const channel = mathChannels[index];
    channel.enabled = document.querySelector(`.math-enabled[data-index="${index}"]`).checked;
    channel.operation = document.querySelector(`.math-operation[data-index="${index}"]`).value;
    channel.a = Number(document.querySelector(`.math-a[data-index="${index}"]`).value);
    channel.b = Number(document.querySelector(`.math-b[data-index="${index}"]`).value);
    updateChannelLegend();
    scheduleDraw();
}

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
            appendRecording(decoded);
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
    const configurationChanged = gpios.join() !== activeGpios.join() || bitWidths.join() !== activeBitWidths.join();
    if (configurationChanged) {
        sampleStarts.fill(0);
        sampleCounts.fill(0);
        triggeredFrame = null;
    }
    activeGpios = gpios;
    activeBitWidths = bitWidths;
    adcMaximum = Math.max(...bitWidths.map(bits => 2 ** bits - 1));
    triggerLevel.max = String(adcMaximum);
    $("full-scale-option").textContent = `Full scale (0–${adcMaximum})`;
    if (configurationChanged) updateChannelLegend();
    return { channels: channels.map((values, channel) => values.subarray(0, positions[channel])),
        totalCount: count };
}

const channelColors = ["#39d98a", "#ffb347", "#5da9ff", "#d875ff", "#ff6b7a", "#66e0e5", "#f5e663", "#ff7bd5"];

function updateChannelLegend() {
    const physical = activeGpios.map((gpio, index) =>
        `<span style="--channel-color:${channelColors[index]}">GPIO${gpio}</span>`);
    const math = mathChannels.flatMap((channel, index) => channel.enabled ?
        [`<span style="--channel-color:${channelColors[6 + index]}">M${index + 1}</span>`] : []);
    $("channel-legend").innerHTML = [...physical, ...math].join("");
    $("input-pin-label").textContent = activeGpios.map(gpio => `GPIO${gpio}`).join("/");
    refreshSourceOptions();
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
        if (sampleCounts[channel] < sampleCapacity) {
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
    const accumulated = sampleCounts.length ? Math.min(...sampleCounts.slice(0, activeChannelCount)) : 0;
    const visibleSamples = accumulated > 0 ? Math.min(maxDataPoints, accumulated) : maxDataPoints;
    const seconds = visibleSamples * activeChannelCount / measuredRate;
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

function crossed(previous, current, level, edge) {
    const rising = previous < level && current >= level;
    const falling = previous > level && current <= level;
    return edge === "rising" ? rising : edge === "falling" ? falling : rising || falling;
}

function rawFrame() {
    const count = Math.min(...sampleCounts.slice(0, activeChannelCount));
    const width = Math.min(maxDataPoints, count);
    if (width < 2) return [];
    let start = count - width;
    let hit = -1;
    if (triggerEnabled.checked && triggerArmed) {
        const source = Math.min(Number(triggerSource.value), activeChannelCount - 1);
        const before = Math.round((width - 1) * Number(triggerPosition.value) / 100);
        const after = width - 1 - before;
        const level = Number(triggerLevel.value);
        for (let i = Math.max(1, before); i < count - after; i++) {
            if (crossed(sampleAt(source, i - 1), sampleAt(source, i), level, triggerEdge.value)) hit = i;
        }
        if (hit >= 0) start = hit - before;
        else if (triggerMode.value !== "auto") return triggeredFrame || [];
    } else if (triggerEnabled.checked && !triggerArmed) {
        return triggeredFrame || [];
    }
    const frame = Array.from({ length: activeChannelCount }, (_, channel) => {
        const values = new Float32Array(width);
        for (let i = 0; i < width; i++) values[i] = sampleAt(channel, start + i);
        return values;
    });
    if (triggerEnabled.checked && hit >= 0) {
        triggeredFrame = frame;
        $("trigger-state").textContent = `Triggered at ${Number(triggerLevel.value).toLocaleString()}`;
        if (triggerMode.value === "single") triggerArmed = false;
    } else if (triggerEnabled.checked) {
        $("trigger-state").textContent = "Armed — waiting for edge";
    }
    return frame;
}

function calculateMath(channel, raw) {
    const a = raw[Math.min(channel.a, raw.length - 1)];
    const b = raw[Math.min(channel.b, raw.length - 1)];
    if (!a) return new Float32Array();
    const result = new Float32Array(a.length);
    const mean = a.reduce((sum, value) => sum + value, 0) / a.length;
    let accumulator = 0;
    for (let i = 0; i < a.length; i++) {
        switch (channel.operation) {
        case "add": result[i] = a[i] + b[i]; break;
        case "subtract": result[i] = a[i] - b[i]; break;
        case "multiply": result[i] = a[i] * b[i] / adcMaximum; break;
        case "divide": result[i] = Math.abs(b[i]) < 1e-9 ? 0 : a[i] / b[i]; break;
        case "average": result[i] = (a[i] + b[i]) / 2; break;
        case "minimum": result[i] = Math.min(a[i], b[i]); break;
        case "maximum": result[i] = Math.max(a[i], b[i]); break;
        case "absolute": result[i] = Math.abs(a[i]); break;
        case "invert": result[i] = adcMaximum - a[i]; break;
        case "dc": result[i] = a[i] - mean; break;
        case "smooth": {
            let sum = 0, samplesInWindow = 0;
            for (let j = Math.max(0, i - 3); j <= Math.min(a.length - 1, i + 3); j++) { sum += a[j]; samplesInWindow++; }
            result[i] = sum / samplesInWindow; break;
        }
        case "derivative": result[i] = i ? a[i] - a[i - 1] : 0; break;
        case "integral": accumulator += a[i] - mean; result[i] = accumulator / Math.max(1, a.length / 100); break;
        }
    }
    return result;
}

function updateRecordStatus(force = false) {
    if (!recording) return;
    const now = performance.now();
    if (!force && now - lastRecordStatusAt < 200) return;
    lastRecordStatusAt = now;
    const duration = recording.counts.length ? Math.min(...recording.counts) / recording.sampleRate : 0;
    $("record-state").textContent = `Recording: ${recording.total.toLocaleString()} / ${recordSampleLimit.toLocaleString()} samples · ${duration.toFixed(3)} s`;
}

function appendRecording(decoded) {
    if (!recording) return;
    if (decoded.channels.length !== recording.gpios.length || activeGpios.join() !== recording.gpios.join()) {
        finishRecording();
        return;
    }
    let remaining = recordSampleLimit - recording.total;
    for (let channel = 0; channel < decoded.channels.length && remaining > 0; channel++) {
        const source = decoded.channels[channel];
        const take = Math.min(source.length, remaining);
        if (take > 0) {
            recording.chunks[channel].push(source.slice(0, take));
            recording.counts[channel] += take;
            recording.total += take;
            remaining -= take;
        }
    }
    updateRecordStatus();
    if (recording.total >= recordSampleLimit) setTimeout(finishRecording, 0);
}

function flattenRecording(record) {
    return record.chunks.map((chunks, channel) => {
        const result = new Uint16Array(record.counts[channel]);
        let offset = 0;
        chunks.forEach(chunk => { result.set(chunk, offset); offset += chunk.length; });
        return result;
    });
}

function downloadCsv(headers, columns, sampleRate, zeroIndex, name) {
    if (!columns.length || !columns[0].length) return;
    const rows = Math.min(...columns.map(column => column.length));
    const parts = ["\ufeff", ["time_s", ...headers].join(","), "\r\n"];
    const batchSize = 10000;
    for (let start = 0; start < rows; start += batchSize) {
        const lines = [];
        const end = Math.min(rows, start + batchSize);
        for (let index = start; index < end; index++) {
            const time = sampleRate > 0 ? (index - zeroIndex) / sampleRate : 0;
            lines.push([time.toPrecision(10), ...columns.map(column => column[index])].join(","));
        }
        parts.push(lines.join("\r\n"), "\r\n");
    }
    const blob = new Blob(parts, { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    link.href = URL.createObjectURL(blob);
    link.download = `${name}-${timestamp}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function startRecording() {
    const channelRate = (measuredRate || Number(sampleRateControl.value)) / Math.max(1, activeChannelCount);
    recording = {
        gpios: [...activeGpios], sampleRate: channelRate,
        chunks: Array.from({ length: activeChannelCount }, () => []),
        counts: Array(activeChannelCount).fill(0), total: 0
    };
    $("record").textContent = "Stop & save";
    $("record").classList.add("recording");
    $("record-state").hidden = false;
    updateRecordStatus(true);
}

function finishRecording() {
    if (!recording) return;
    const completed = recording;
    recording = null;
    $("record").textContent = "Record";
    $("record").classList.remove("recording");
    $("record-state").hidden = true;
    downloadCsv(completed.gpios.map(gpio => `GPIO${gpio}`), flattenRecording(completed),
        completed.sampleRate, 0, "esp32-scope-recording");
}

function windowCoefficient(kind, index, count) {
    if (count < 2 || kind === "rectangular") return 1;
    const angle = 2 * Math.PI * index / (count - 1);
    if (kind === "hamming") return 0.54 - 0.46 * Math.cos(angle);
    if (kind === "blackman") return 0.42 - 0.5 * Math.cos(angle) + 0.08 * Math.cos(2 * angle);
    return 0.5 - 0.5 * Math.cos(angle);
}

function fft(real, imaginary) {
    const count = real.length;
    for (let i = 1, j = 0; i < count; i++) {
        let bit = count >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [real[i], real[j]] = [real[j], real[i]];
            [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
        }
    }
    for (let length = 2; length <= count; length <<= 1) {
        const angle = -2 * Math.PI / length;
        const stepReal = Math.cos(angle), stepImaginary = Math.sin(angle);
        for (let start = 0; start < count; start += length) {
            let rotationReal = 1, rotationImaginary = 0;
            for (let offset = 0; offset < length / 2; offset++) {
                const even = start + offset, odd = even + length / 2;
                const oddReal = real[odd] * rotationReal - imaginary[odd] * rotationImaginary;
                const oddImaginary = real[odd] * rotationImaginary + imaginary[odd] * rotationReal;
                real[odd] = real[even] - oddReal; imaginary[odd] = imaginary[even] - oddImaginary;
                real[even] += oddReal; imaginary[even] += oddImaginary;
                const nextReal = rotationReal * stepReal - rotationImaginary * stepImaginary;
                rotationImaginary = rotationReal * stepImaginary + rotationImaginary * stepReal;
                rotationReal = nextReal;
            }
        }
    }
}

function formatFrequency(value) {
    return value >= 1e6 ? `${(value / 1e6).toFixed(1)} MHz` :
        value >= 1e3 ? `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)} kHz` : `${value.toFixed(0)} Hz`;
}

function drawSpectrum(raw) {
    if (!spectrumEnabled.checked || !raw.length) return;
    const source = spectrumSource.value;
    const values = source.startsWith("m") ? calculateMath(mathChannels[Number(source.slice(1))], raw) :
        raw[Math.min(Number(source.slice(1)), raw.length - 1)];
    let count = 1;
    while (count * 2 <= Math.min(4096, values.length)) count *= 2;
    if (count < 8) return;
    const real = new Float64Array(count), imaginary = new Float64Array(count);
    const offset = values.length - count;
    let mean = 0, windowSum = 0;
    for (let i = 0; i < count; i++) mean += values[offset + i];
    mean /= count;
    for (let i = 0; i < count; i++) {
        const coefficient = windowCoefficient(spectrumWindow.value, i, count);
        real[i] = (values[offset + i] - mean) * coefficient;
        windowSum += coefficient;
    }
    fft(real, imaginary);
    const bins = count / 2;
    const plotted = new Float32Array(bins);
    for (let i = 0; i < bins; i++) {
        const magnitude = 2 * Math.hypot(real[i], imaginary[i]) / Math.max(1, windowSum);
        if (spectrumMode.value === "db") plotted[i] = 20 * Math.log10(Math.max(magnitude, 1e-9));
        else if (spectrumMode.value === "psd") plotted[i] = magnitude * magnitude;
        else if (spectrumMode.value === "phase") plotted[i] = Math.atan2(imaginary[i], real[i]) * 180 / Math.PI;
        else plotted[i] = magnitude;
    }
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(spectrumCanvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(spectrumCanvas.clientHeight * ratio));
    if (spectrumCanvas.width !== width || spectrumCanvas.height !== height) {
        spectrumCanvas.width = width; spectrumCanvas.height = height;
    }
    const left = 52 * ratio, bottom = 24 * ratio, plotWidth = width - left, plotHeight = height - bottom;
    let minimum = spectrumMode.value === "phase" ? -180 : Math.min(...plotted);
    let maximum = spectrumMode.value === "phase" ? 180 : Math.max(...plotted);
    if (!Number.isFinite(minimum) || maximum <= minimum) { minimum = 0; maximum = 1; }
    const padding = spectrumMode.value === "phase" ? 0 : (maximum - minimum) * 0.08;
    minimum -= padding; maximum += padding;
    spectrumContext.fillStyle = "#090e15"; spectrumContext.fillRect(0, 0, width, height);
    spectrumContext.strokeStyle = "#182330"; spectrumContext.lineWidth = 1; spectrumContext.beginPath();
    for (let i = 0; i <= 10; i++) { const x = left + plotWidth * i / 10; spectrumContext.moveTo(x, 0); spectrumContext.lineTo(x, plotHeight); }
    for (let i = 0; i <= 4; i++) { const y = plotHeight * i / 4; spectrumContext.moveTo(left, y); spectrumContext.lineTo(width, y); }
    spectrumContext.stroke();
    spectrumContext.fillStyle = "#60738b"; spectrumContext.font = `${10 * ratio}px ui-monospace, monospace`;
    const channelRate = measuredRate / Math.max(1, activeChannelCount);
    spectrumContext.textBaseline = "bottom";
    for (let i = 0; i <= 5; i++) {
        spectrumContext.textAlign = i === 0 ? "left" : i === 5 ? "right" : "center";
        spectrumContext.fillText(formatFrequency(channelRate * 0.5 * i / 5), left + plotWidth * i / 5, height - 3 * ratio);
    }
    spectrumContext.textAlign = "right"; spectrumContext.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) spectrumContext.fillText((maximum - (maximum - minimum) * i / 4).toFixed(1), left - 6 * ratio, plotHeight * i / 4);
    spectrumContext.strokeStyle = "#66e0e5"; spectrumContext.lineWidth = Math.max(1, ratio); spectrumContext.beginPath();
    for (let i = 0; i < bins; i++) {
        const x = left + plotWidth * i / (bins - 1);
        const y = plotHeight - (plotted[i] - minimum) * plotHeight / (maximum - minimum);
        if (i === 0) spectrumContext.moveTo(x, y); else spectrumContext.lineTo(x, y);
    }
    spectrumContext.stroke();
}

function draw(timestamp = performance.now()) {
    drawPending = false;
    lastDrawAt = timestamp;
    const ratio = resizeCanvas();
    const raw = rawFrame();
    lastRenderedRaw = raw;
    const series = raw.map((values, index) => ({ values, color: channelColors[index] }));
    mathChannels.forEach((channel, index) => {
        if (channel.enabled && raw.length) series.push({ values: calculateMath(channel, raw), color: channelColors[6 + index] });
    });
    let minimum = Infinity, maximum = -Infinity;
    series.forEach(item => item.values.forEach(value => {
        if (Number.isFinite(value)) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
    }));
    let yMinimum = 0, yMaximum = adcMaximum;
    if (verticalScale.value === "auto" && Number.isFinite(minimum)) {
        if (triggerEnabled.checked) {
            minimum = Math.min(minimum, Number(triggerLevel.value));
            maximum = Math.max(maximum, Number(triggerLevel.value));
        }
        const padding = Math.max(1, (maximum - minimum) * 0.1);
        yMinimum = minimum - padding;
        yMaximum = maximum + padding;
        if (yMaximum - yMinimum < 2) { yMinimum -= 1; yMaximum += 1; }
    }
    const { left, plotWidth, plotHeight } = drawGrid(canvas.width, canvas.height, ratio, yMinimum, yMaximum);
    triggerGeometry = { left, plotWidth, plotHeight, ratio, yMinimum, yMaximum };
    series.forEach(item => {
        const count = item.values.length;
        if (count < 2) return;
        context.strokeStyle = item.color;
        context.lineWidth = Math.max(1, ratio);
        context.beginPath();
        const columns = Math.max(1, Math.floor(plotWidth));
        const groupSize = Math.max(1, Math.ceil(count / columns));
        if (groupSize === 1) {
            const xScale = plotWidth / (count - 1);
            for (let index = 0; index < count; index++) {
                const value = item.values[index];
                const x = left + index * xScale;
                const y = plotHeight - (value - yMinimum) * plotHeight / (yMaximum - yMinimum);
                if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
            }
        } else {
            for (let start = 0, column = 0; start < count; start += groupSize, column++) {
                let low = Infinity, high = -Infinity;
                const end = Math.min(start + groupSize, count);
                for (let i = start; i < end; i++) {
                    const value = item.values[i];
                    if (value < low) low = value;
                    if (value > high) high = value;
                }
                const x = left + column * plotWidth / Math.ceil(count / groupSize);
                context.moveTo(x, plotHeight - (low - yMinimum) * plotHeight / (yMaximum - yMinimum));
                context.lineTo(x, plotHeight - (high - yMinimum) * plotHeight / (yMaximum - yMinimum));
            }
        }
        context.stroke();
    });

    if (triggerEnabled.checked && Number(triggerSource.value) < raw.length) {
        const y = plotHeight - (Number(triggerLevel.value) - yMinimum) * plotHeight / (yMaximum - yMinimum);
        context.strokeStyle = "#ffcc66"; context.setLineDash([5 * ratio, 5 * ratio]); context.beginPath();
        context.moveTo(left, y); context.lineTo(canvas.width, y); context.stroke(); context.setLineDash([]);
        const x = left + plotWidth * Number(triggerPosition.value) / 100;
        context.strokeStyle = "rgba(255, 204, 102, .45)"; context.setLineDash([3 * ratio, 6 * ratio]); context.beginPath();
        context.moveTo(x, 0); context.lineTo(x, plotHeight); context.stroke(); context.setLineDash([]);
        context.fillStyle = "#ffcc66"; context.beginPath(); context.moveTo(x, 0); context.lineTo(x - 5 * ratio, 8 * ratio); context.lineTo(x + 5 * ratio, 8 * ratio); context.fill();
    }
    drawSpectrum(raw);
}

function scheduleDraw() {
    if (drawPending) return;
    drawPending = true;
    const delay = Math.max(0, 33 - (performance.now() - lastDrawAt));
    if (delay > 1) setTimeout(() => requestAnimationFrame(draw), delay);
    else requestAnimationFrame(draw);
}

historySlider.addEventListener("input", () => {
    maxDataPoints = Number(historySlider.value);
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
    triggeredFrame = null;
    triggerArmed = true;
    if (triggerEnabled.checked) $("trigger-state").textContent = "Armed — waiting for edge";
    scheduleDraw();
});
$("save-csv").addEventListener("click", () => {
    if (!lastRenderedRaw.length || !lastRenderedRaw[0].length) return;
    const math = mathChannels.map(channel => channel.enabled ? calculateMath(channel, lastRenderedRaw) : null);
    const headers = ["time_s", ...activeGpios.map(gpio => `GPIO${gpio}`),
        ...math.flatMap((values, index) => values ? [`M${index + 1}`] : [])];
    const sampleRate = measuredRate / Math.max(1, activeChannelCount);
    const triggerIndex = triggerEnabled.checked ?
        Math.round((lastRenderedRaw[0].length - 1) * Number(triggerPosition.value) / 100) :
        lastRenderedRaw[0].length - 1;
    downloadCsv(headers.slice(1), [...lastRenderedRaw, ...math.filter(Boolean)],
        sampleRate, triggerIndex, "esp32-scope");
});
$("record").addEventListener("click", () => recording ? finishRecording() : startRecording());
window.addEventListener("resize", scheduleDraw);
verticalScale.addEventListener("change", scheduleDraw);
[spectrumSource, spectrumMode, spectrumWindow].forEach(control => control.addEventListener("change", scheduleDraw));
spectrumEnabled.addEventListener("change", () => {
    document.querySelector(".spectrum-card").classList.toggle("enabled", spectrumEnabled.checked);
    scheduleDraw();
});
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
[triggerEnabled, triggerMode, triggerSource, triggerEdge, triggerLevel].forEach(control =>
    control.addEventListener("change", () => {
        triggerArmed = true;
        triggeredFrame = null;
        $("trigger-state").textContent = triggerEnabled.checked ? "Armed — waiting for edge" : "Trigger off";
        scheduleDraw();
    }));
triggerPosition.addEventListener("input", () => {
    $("trigger-position-value").textContent = `${triggerPosition.value}%`;
    triggerArmed = true;
    triggeredFrame = null;
    scheduleDraw();
});
$("trigger-arm").addEventListener("click", () => {
    triggerArmed = true;
    triggeredFrame = null;
    triggerEnabled.checked = true;
    $("trigger-state").textContent = "Armed — waiting for edge";
    scheduleDraw();
});
canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const direction = event.deltaY > 0 ? 1 : -1;
    const next = Math.max(Number(historySlider.min), Math.min(Number(historySlider.max),
        Number(historySlider.value) + direction * Number(historySlider.step)));
    historySlider.value = String(next);
    historySlider.dispatchEvent(new Event("input"));
}, { passive: false });

function triggerPointerPosition(event) {
    const rectangle = canvas.getBoundingClientRect();
    const ratio = triggerGeometry?.ratio || 1;
    return { x: (event.clientX - rectangle.left) * ratio, y: (event.clientY - rectangle.top) * ratio };
}

function triggerHitTest(event) {
    if (!triggerEnabled.checked || !triggerGeometry) return null;
    const { x, y } = triggerPointerPosition(event);
    const geometry = triggerDragGeometry || triggerGeometry;
    const positionX = geometry.left + geometry.plotWidth * Number(triggerPosition.value) / 100;
    const levelY = geometry.plotHeight - (Number(triggerLevel.value) - geometry.yMinimum) *
        geometry.plotHeight / (geometry.yMaximum - geometry.yMinimum);
    const tolerance = 12 * geometry.ratio;
    if (Math.abs(x - positionX) <= tolerance && y <= geometry.plotHeight) return "position";
    if (Math.abs(y - levelY) <= tolerance && x >= geometry.left) return "level";
    return null;
}

function updateTriggerFromPointer(event) {
    const { x, y } = triggerPointerPosition(event);
    const geometry = triggerDragGeometry || triggerGeometry;
    if (triggerDrag === "position") {
        const percent = 100 * (x - geometry.left) / geometry.plotWidth;
        triggerPosition.value = String(Math.max(Number(triggerPosition.min),
            Math.min(Number(triggerPosition.max), Math.round(percent))));
        $("trigger-position-value").textContent = `${triggerPosition.value}%`;
    } else if (triggerDrag === "level") {
        const value = geometry.yMaximum - y * (geometry.yMaximum - geometry.yMinimum) / geometry.plotHeight;
        triggerLevel.value = String(Math.max(0, Math.min(adcMaximum, Math.round(value))));
    }
    triggerArmed = true;
    triggeredFrame = null;
    $("trigger-state").textContent = "Armed — waiting for edge";
    scheduleDraw();
}

canvas.addEventListener("pointerdown", event => {
    triggerDrag = triggerHitTest(event);
    if (!triggerDrag) return;
    triggerDragGeometry = { ...triggerGeometry };
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    updateTriggerFromPointer(event);
});
canvas.addEventListener("pointermove", event => {
    if (triggerDrag) {
        event.preventDefault();
        updateTriggerFromPointer(event);
        return;
    }
    const hit = triggerHitTest(event);
    canvas.style.cursor = hit === "position" ? "col-resize" : hit === "level" ? "row-resize" : "default";
});
function finishTriggerDrag(event) {
    if (!triggerDrag) return;
    triggerDrag = null;
    triggerDragGeometry = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}
canvas.addEventListener("pointerup", finishTriggerDrag);
canvas.addEventListener("pointercancel", finishTriggerDrag);
initializeMathControls();
historySlider.dispatchEvent(new Event("input"));
updateChannelLegend();
scheduleDraw();
requestAnimationFrame(() => setTimeout(connect, 0));

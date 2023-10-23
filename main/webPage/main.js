const proto = require('./wsInterface_pb.js');

let host_addres = window.location.host;
host_addres = "192.168.0.20";
let web_socket_uri = "ws://" + host_addres + "/ws";
console.log(web_socket_uri);
let socket = new WebSocket(web_socket_uri);

socket.onopen = function (e) {

};

socket.onclose = function (event) {
    alert("Conetion is closed.");
};

socket.onerror = function (error) {
    alert("Error during connection.");
};

// Initialize dataPoints array
var dataPoints = [];

// Set the maximum number of data points to display
const maxDataPoints = 10000; // Adjust as needed

// Get the canvas element and its context
var canvas = document.getElementById("chart");
var ctx = canvas.getContext("2d");

// Variables for chart dimensions
var chartWidth = canvas.width;
var chartHeight = canvas.height;
var margin = 20;

// Variables for chart axes
var xScale, yScale;
var xAxisLength, yAxisLength;
var xAxisPos, yAxisPos;

// Variable to track uptime
var uptime = 0;

// Define a function to update the chart
function updateChart(newADCValues) {

    // Calculate the start time for the new data based on the existing data
    var startTime = dataPoints.length > 0 ? dataPoints[dataPoints.length - 1][0] + 1 : 0;

    // Generate new data points using the provided ADC values and start time
    var newDataPoints = newADCValues.map(function (adcValue, index) {
        return { x: startTime + index, y: adcValue };
    });

    // Add the new data points to the dataPoints array
    dataPoints.push.apply(dataPoints, newDataPoints);

    // Remove older data points if the total number exceeds maxDataPoints
    if (dataPoints.length > maxDataPoints) {
        var excess = dataPoints.length - maxDataPoints;
        dataPoints.splice(0, excess); // Remove the oldest data points
    }

    // Clear the canvas
    ctx.clearRect(0, 0, chartWidth, chartHeight);

    // Draw the axis
    drawAxes();

    // Draw the line chart
    drawLineChart();

    // Increment uptime
    uptime++;
}

socket.onmessage = async function (event) {

    // let jsonObject = JSON.parse(event.data);
    // console.log(jsonObject.Ch1Data);
    // updateChart(jsonObject.Ch1Data);

    let array = await event.data.arrayBuffer();
    // console.log(array);
    // console.log(event.data);
    console.log("lenght: ", event.data.size);
    const decodedMessage = proto.AdcDataTest3.deserializeBinary(array);
    let obj = decodedMessage.toObject();
    console.log(obj);

    // updateChart(obj.indexList);
};

// Function to draw the chart axes
function drawAxes() {
    ctx.beginPath();
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 2;

    // X-axis
    ctx.moveTo(margin, chartHeight - margin);
    ctx.lineTo(chartWidth - margin, chartHeight - margin);

    // Y-axis
    ctx.moveTo(margin, margin);
    ctx.lineTo(margin, chartHeight - margin);

    ctx.stroke();
    ctx.closePath();

    // Calculate axis dimensions and positions
    xAxisLength = chartWidth - 2 * margin;
    yAxisLength = chartHeight - 2 * margin;
    xAxisPos = margin;
    yAxisPos = chartHeight - margin;

    // Create scales for X and Y axes
    xScale = xAxisLength / (maxDataPoints - 1);
    yScale = yAxisLength / 4096; // Assumes the ADC values range from 0 to 100

    // Draw X-axis labels
    for (var i = 0; i < maxDataPoints; i += Math.floor(maxDataPoints / 10)) {
        var xLabel = i.toString();
        var xLabelWidth = ctx.measureText(xLabel).width;
        var x = margin + i * xScale - xLabelWidth / 2;
        var y = yAxisPos + margin / 2 + 10; // Adjust for label position
        ctx.fillText(xLabel, x, y);
    }

    // Draw Y-axis labels
    for (var j = 0; j <= 100; j += 20) {
        var yLabel = j.toString();
        var yLabelWidth = ctx.measureText(yLabel).width;
        var x = margin / 2 - yLabelWidth / 2;
        var y = yAxisPos - j * yScale + 5; // Adjust for label position
        ctx.fillText(yLabel, x, y);
    }

    // Label the X and Y axes
    ctx.fillText("Uptime (seconds)", xAxisPos + xAxisLength / 2, yAxisPos + margin / 2 + 30);

    ctx.save();
    ctx.translate(margin / 2 - 50, yAxisPos + yAxisLength / 2);
    ctx.rotate(-Math.PI / 2); // Rotate counterclockwise by 90 degrees
    ctx.fillStyle = "#333";
    ctx.fillText("ADC Value", 0, 0);
    ctx.restore();
}

// Function to draw the line chart
function drawLineChart() {
    ctx.beginPath();
    ctx.strokeStyle = "blue";
    ctx.lineWidth = 2;

    dataPoints.forEach(function (point, index) {
        var x = xAxisPos + index * xScale;
        var y = yAxisPos - point.y * yScale;
        if (index === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });

    ctx.stroke();
    ctx.closePath();
}

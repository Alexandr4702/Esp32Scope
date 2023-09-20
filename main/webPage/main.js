// Initialize dataPoints array
var dataPoints = [];

// Set the maximum number of data points to display
const maxDataPoints = 100; // Adjust as needed

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
function updateChart() {
    // Replace this line with code to fetch new ADC data
    var adcValue = Math.random() * 100; // Replace with your actual ADC data source

    // Add the new data point to the dataPoints array
    dataPoints.push({ x: uptime, y: adcValue });

    // Remove older data points if the number exceeds maxDataPoints
    if (dataPoints.length > maxDataPoints) {
        dataPoints.shift(); // Remove the first (oldest) data point
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

// Call the updateChart function to update the chart periodically
setInterval(updateChart, 10); // Update every second, adjust as needed

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
    yScale = yAxisLength / 100; // Assumes the ADC values range from 0 to 100

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

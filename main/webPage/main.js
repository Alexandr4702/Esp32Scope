"use strict";

google.charts.load('current', { 'packages': ['corechart'] });

let frequency = 20000;
let period = 1 / 20000;

const maxDataPoints = 100;

let dataPoints = [];

let chart;
let options;

let host_addres = window.location.host;
let socket = new WebSocket("ws://" + host_addres + "/ws");

socket.onopen = function (e) {

};

socket.onmessage = function (event) {
  let data = JSON.parse(event.data)
  console.log(data.Ch1Data);

};

socket.onclose = function (event) {
  if (event.wasClean) {
    alert(`[close] Connection closed cleanly, code=${event.code} reason=${event.reason}`);
  } else {
    alert('[close] Connection died');
  }
};

socket.onerror = function (error) {
  alert(`[error] ${error.message}`);
};

// Set chart options
options = {
  title: 'ADC Data',
  curveType: 'function',
  legend: { position: 'bottom' },
  width: '100%', // Set initial width to 100% for responsiveness
  height: '400', // Set an initial height
};

// letiable to track uptime
let uptime = 0;

function updateChart() {
  // Replace these lines with code to fetch new ADC data
  let adcValue = Math.random() * 100; // Replace with your actual ADC data source

  // Add the new data point to the dataPoints array
  dataPoints.push([uptime, adcValue]);

  // Remove older data points if the total number exceeds maxDataPoints
  if (dataPoints.length > maxDataPoints) {
    let excess = dataPoints.length - maxDataPoints;
    dataPoints.splice(0, excess); // Remove the oldest data points
  }

  // Set the data in the DataTable
  let data = new google.visualization.DataTable();
  data.addColumn('number', 'Uptime (seconds)');
  data.addColumn('number', 'ADC Value');
  data.addRows(dataPoints);

  // Update the chart with the new data
  chart.draw(data, options);

  // Increment uptime
  uptime++;
}

google.charts.setOnLoadCallback(function () {
  // Create the DataTable with initial columns
  let data = new google.visualization.DataTable();
  data.addColumn('number', 'Uptime (seconds)');
  data.addColumn('number', 'ADC Value');

  // Create the chart
  chart = new google.visualization.LineChart(document.getElementById('chart_div'));

  // Call the updateChart function to update the chart periodically
  setInterval(updateChart, 10); // Update every second, adjust as needed

  // Handle window resize events to make the chart responsive
  window.addEventListener('resize', function () {
    chart.draw(data, options);
  });
});
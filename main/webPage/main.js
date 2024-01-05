const proto = require('./wsInterface_pb.js');
const Dygraph = require('dygraphs');

let host_addres = window.location.host;
host_addres = "192.168.0.27";
let web_socket_uri = "ws://" + host_addres + "/ws";
console.log(web_socket_uri);
let socket = new WebSocket(web_socket_uri);

let maxDataPoints = 8000;

let totalNumberOfRecivedSmp = 0;
var data = [];
var t = 0;

var g = new Dygraph(document.getElementById("div_g"), data,
    {
        resizable: "both",
        drawPoints: true,
        //  showRoller: true,
        //  animatedZooms: true,
        valueRange: [-100, 3000],
        labels: ['X', 'Random']
    });

function getPageUptime() {
    // Get the time when the page was loaded
    var loadTime = new Date(performance.timing.navigationStart);

    // Get the current time
    var currentTime = new Date();

    // Calculate the uptime in milliseconds
    var uptime = currentTime - loadTime;

    return uptime / 1000;
}

socket.onopen = function (e) {

};

socket.onclose = function (event) {
    alert("Conetion is closed.");
};

socket.onerror = function (error) {
    alert("Error during connection.");
};

socket.onmessage = async function (event) {
    let array = await event.data.arrayBuffer();

    const decodedMessage = proto.AdcDataTest3.deserializeBinary(array);

    let adc_rec_8 = decodedMessage.getAdcdata_asU8();

    for (let i = 0; i < adc_rec_8.length / 2; i++) {
        let AdcData = (adc_rec_8[i * 2] | (adc_rec_8[i * 2 + 1] << 8));
        let val = AdcData & 0xfff;
        let chanel = (AdcData & 0xF000) >> 12;
        x = (data.length == 0) ? t + 1 : data[data.length - 1][0] + 1;
        data.push([x, val]);
    }

    if (data.length > maxDataPoints) {
        let excess = data.length - maxDataPoints;
        data.splice(0, excess); // Remove the oldest data points
    }

    // let uptime_s = getPageUptime();
    // totalNumberOfRecivedSmp += adc_data.length;

    // console.log(data.length);

    g.updateOptions({ 'file': data });
};


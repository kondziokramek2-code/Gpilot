const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
cors: {
origin: '*'
}
});

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Store active flights and ATCs
const activeFlights = new Map();
const activeATCs = new Map();

function broadcastMapUpdate() {
io.emit('map_update', {
flights: Array.from(activeFlights.values()),
atcs: Array.from(activeATCs.values())
});
}

io.on('connection', (socket) => {
console.log('Client connected: ' + socket.id);

// Receive flight data update from Python client
socket.on('flight_update', (data) => {
    if (!data || !data.flight_number) {
        return;
    }

    const existing = activeFlights.get(socket.id);

    if (existing && existing.path) {
        data.path = existing.path;

        const lastPos = data.path[data.path.length - 1];

        if (lastPos[0] !== data.lat || lastPos[1] !== data.lon) {
            data.path.push([data.lat, data.lon]);
        }
    } else {
        data.path = [[data.lat, data.lon]];
    }

    activeFlights.set(socket.id, data);
    broadcastMapUpdate();
});

// Receive ATC login
socket.on('atc_login', (data) => {
    if (!data || !data.callsign) {
        return;
    }

    activeATCs.set(socket.id, data);
    broadcastMapUpdate();
});

// Voice chat rooms
socket.on('set_frequency', (freq) => {
    if (socket.currentFreq) {
        socket.leave(socket.currentFreq);
    }

    const roomName = 'freq_' + freq;

    socket.join(roomName);
    socket.currentFreq = roomName;

    console.log('Client ' + socket.id + ' tuned to frequency: ' + freq);
});

socket.on('check_frequency', (freq) => {
    const roomName = 'freq_' + freq;

    const isOccupied =
        io.sockets.adapter.rooms.has(roomName) &&
        io.sockets.adapter.rooms.get(roomName).size > 0;

    socket.emit('frequency_check_result', isOccupied);
});

// Voice data routing
socket.on('voice_data', (audioBytes) => {
    if (socket.currentFreq) {
        socket.to(socket.currentFreq).emit('voice_data', audioBytes);
    }
});

socket.on('disconnect', () => {
    console.log('Client disconnected: ' + socket.id);

    let changed = false;

    if (activeFlights.has(socket.id)) {
        activeFlights.delete(socket.id);
        changed = true;
    }

    if (activeATCs.has(socket.id)) {
        activeATCs.delete(socket.id);
        changed = true;
    }

    if (changed) {
        broadcastMapUpdate();
    }
});

});

const PORT = process.env.PORT || 8080;

// Dostęp z localhost oraz innych urządzeń w sieci
server.listen(PORT, '0.0.0.0', () => {
console.log('GPilot Web Server running on port ' + PORT);
console.log('Local address: http://localhost:' + PORT);
});

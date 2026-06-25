const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  cors: {
    origin: '*'
  }
});

// Store active flights and ATCs
const activeFlights = new Map();
const activeATCs = new Map();

// Keep track of signal states for sender-receiver pairs
// key: senderId_receiverId
// value: { lostSignal: boolean, lastQuality: number, lastUpdateTime: number }
const connectionStates = new Map();

// Configuration for radio range calculations
const FADE_START_RATIO = 0.70;
const HEAVY_NOISE_RATIO = 0.90;
const LOST_SIGNAL_RATIO = 1.00;
const REACQUIRE_RATIO = 0.92;
const SIGNAL_SMOOTHING_MS = 300;
const STATION_ANTENNA_HEIGHT_FT = 100;

function normalizeFrequency(freq) {
  if (freq === undefined || freq === null) return '0.000';
  const val = parseFloat(freq);
  if (isNaN(val)) return '0.000';
  return val.toFixed(3);
}

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
    const normalized = normalizeFrequency(freq);
    if (socket.currentFreq) {
      socket.leave('freq_' + socket.currentFreq);
    }

    socket.join('freq_' + normalized);
    socket.currentFreq = normalized;

    console.log('Client ' + socket.id + ' tuned to frequency: ' + normalized);
  });

  // Voice data routing with range checks
  socket.on('voice_data', (audioBytes) => {
    if (socket.currentFreq) {
      const roomName = 'freq_' + socket.currentFreq;
      const room = io.sockets.adapter.rooms.get(roomName);

      if (room && room.size > 0) {
        const clientIds = Array.from(room);
        const sender = activeFlights.get(socket.id) || activeATCs.get(socket.id);

        clientIds.forEach(clientId => {
          if (clientId === socket.id) {
            return; // Skip self
          }

          const clientSocket = io.sockets.sockets.get(clientId);
          if (!clientSocket) {
            return;
          }

          const receiver = activeFlights.get(clientId) || activeATCs.get(clientId);

          // Fallback: If telemetry is missing for sender or receiver, transmit at full signal quality (1.0)
          const hasSenderCoords = sender && sender.lat !== undefined && sender.lon !== undefined;
          const hasReceiverCoords = receiver && receiver.lat !== undefined && receiver.lon !== undefined;

          if (!hasSenderCoords || !hasReceiverCoords) {
            clientSocket.emit('voice_data', {
              audioBytes,
              signalQuality: 1.0,
              frequencyMHz: parseFloat(socket.currentFreq),
              radioInRange: true
            });
            return;
          }

          const isSenderATC = activeATCs.has(socket.id);
          // MSFSConnector has alt. We check if alt_agl exists, otherwise use alt (MSL) as temporary fallback.
          const senderHeightFt = isSenderATC ? STATION_ANTENNA_HEIGHT_FT : (sender.alt_agl !== undefined && sender.alt_agl !== null ? sender.alt_agl : sender.alt);

          const isReceiverATC = activeATCs.has(clientId);
          const receiverHeightFt = isReceiverATC ? STATION_ANTENNA_HEIGHT_FT : (receiver.alt_agl !== undefined && receiver.alt_agl !== null ? receiver.alt_agl : receiver.alt);

          // Calculate distance using Haversine formula
          const distanceNm = calculateDistance(sender, receiver);
          const rangeNm = 1.23 * (
            Math.sqrt(Math.max(0, senderHeightFt)) +
            Math.sqrt(Math.max(0, receiverHeightFt))
          );

          // Hysteresis and signal quality calculation
          const stateKey = `${socket.id}_${clientId}`;
          let state = connectionStates.get(stateKey);
          if (!state) {
            state = {
              lostSignal: false,
              lastQuality: 1.0,
              lastUpdateTime: Date.now()
            };
            connectionStates.set(stateKey, state);
          }

          const ratio = rangeNm > 0 ? (distanceNm / rangeNm) : (distanceNm === 0 ? 0 : 999);

          // Update hysteresis state
          if (ratio > LOST_SIGNAL_RATIO) {
            state.lostSignal = true;
          } else if (state.lostSignal && ratio < REACQUIRE_RATIO) {
            state.lostSignal = false;
          }

          let targetQuality = 0.0;
          if (!state.lostSignal) {
            if (ratio <= FADE_START_RATIO) {
              targetQuality = 1.0;
            } else if (ratio <= HEAVY_NOISE_RATIO) {
              // Linear drop from 1.0 to 0.5
              targetQuality = 1.0 - 0.5 * (ratio - FADE_START_RATIO) / (HEAVY_NOISE_RATIO - FADE_START_RATIO);
            } else if (ratio <= LOST_SIGNAL_RATIO) {
              // Linear drop from 0.5 to 0.0
              targetQuality = 0.5 * (LOST_SIGNAL_RATIO - ratio) / (LOST_SIGNAL_RATIO - HEAVY_NOISE_RATIO);
            } else {
              targetQuality = 0.0;
            }
          }

          // Apply smoothing over ~300ms
          const now = Date.now();
          const dt = now - state.lastUpdateTime;
          state.lastUpdateTime = now;

          let quality = targetQuality;
          if (dt > 0 && dt < 2000) {
            const alpha = dt / (dt + SIGNAL_SMOOTHING_MS);
            quality = state.lastQuality + (targetQuality - state.lastQuality) * alpha;
          }
          state.lastQuality = quality;

          // Only send if within range and quality is positive
          if (ratio <= LOST_SIGNAL_RATIO && !state.lostSignal && quality > 0.0) {
            clientSocket.emit('voice_data', {
              audioBytes,
              signalQuality: quality,
              frequencyMHz: parseFloat(socket.currentFreq),
              radioInRange: true
            });
          }
        });
      }
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

    // Clean up connection states to prevent memory leak
    for (const [key, val] of connectionStates.entries()) {
      if (key.startsWith(socket.id + '_') || key.endsWith('_' + socket.id)) {
        connectionStates.delete(key);
      }
    }

    if (changed) {
      broadcastMapUpdate();
    }
  });
});

const PORT = process.env.PORT || 8090;

// Dostęp z localhost oraz innych urządzeń w sieci
server.listen(PORT, '0.0.0.0', () => {
  console.log('GPilot Web Server running on port ' + PORT);
  console.log('Local address: http://localhost:' + PORT);
});

// Haversine distance calculation function
function calculateDistance(sender, receiver) {
  if (!sender || !receiver) return 999999;
  const lat1 = sender.lat;
  const lon1 = sender.lon;
  const lat2 = receiver.lat;
  const lon2 = receiver.lon;

  if (lat1 === undefined || lon1 === undefined || lat2 === undefined || lon2 === undefined) {
    return 999999;
  }

  const R = 3440.065; // Earth radius in nautical miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
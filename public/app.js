// Initialize Leaflet Map
// Center roughly on Europe for start
const map = L.map('map', {
    zoomControl: false // Move zoom control if needed
}).setView([51.505, -0.09], 4);

// Add Zoom control to bottom right
L.control.zoom({
    position: 'bottomright'
}).addTo(map);

// Use OpenStreetMap standard tiles (will be inverted to dark mode via CSS)
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

// SVG string for the airplane icon
const planeSvg = `
<svg class="plane-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M21,16V14L13,9V3.5A1.5,1.5 0 0,0 11.5,2A1.5,1.5 0 0,0 10,3.5V9L2,14V16L10,13.5V19L8,20.5V22L11.5,21L15,22V20.5L13,19V13.5L21,16Z" />
</svg>
`;

const atcSvg = `
<svg class="atc-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M12,2A2,2 0 0,1 14,4C14,4.74 13.6,5.39 13,5.73V7H14A7,7 0 0,1 21,14H22V22H2V14H3A7,7 0 0,1 10,7H11V5.73C10.4,5.39 10,4.74 10,4A2,2 0 0,1 12,2M12,9A5,5 0 0,0 7,14H17A5,5 0 0,0 12,9Z" />
</svg>
`;

// Markers map to keep track of planes on map (key: flight_number or socket_id, value: L.marker)
const planeMarkers = new Map();
// Markers map to keep track of ATCs on map (key: airport, value: L.marker)
const atcMarkers = new Map();

// Polylines for the currently selected flight
let activeFlightLine = null;
let activeDestinationLine = null;
let selectedFlightId = null;

// Connect to Socket.IO Server
const socket = io();

const flightsListEl = document.getElementById('flights-list');
const flightCountEl = document.getElementById('flight-count');

socket.on('connect', () => {
    console.log('Connected to server');
});

// Receive map update
socket.on('map_update', (data) => {
    // data is { flights: [...], atcs: [...] }
    let flights = Array.isArray(data) ? data : data.flights; // fallback for older clients
    let atcs = data.atcs || [];

    updateUI(flights);
    updateMap(flights, atcs);
});

function updateUI(flights) {
    flightCountEl.innerText = flights.length;
    
    if (flights.length === 0) {
        flightsListEl.innerHTML = '<li class="empty-state">Oczekiwanie na pilotów...</li>';
        return;
    }

    flightsListEl.innerHTML = ''; // Clear list
    flights.forEach(flight => {
        const li = document.createElement('li');
        li.className = 'flight-card';
        
        // Add a click listener to pan to the plane
        li.style.cursor = 'pointer';
        li.onclick = () => {
            map.flyTo([flight.lat, flight.lon], 10, {
                animate: true,
                duration: 1.5
            });
        };

        li.innerHTML = `
            <h3>${flight.airline} ${flight.flight_number}</h3>
            <div class="route">${flight.departure} ➔ ${flight.destination}</div>
            <div class="stats">
                <div>Alt: <span class="stat-value">${Math.round(flight.alt)} ft</span></div>
                <div>Hdg: <span class="stat-value">${Math.round(flight.heading)}°</span></div>
                <div style="grid-column: span 2;">COM1: <span class="stat-value" style="color: #66fcf1">${flight.com1_freq ? flight.com1_freq.toFixed(3) : '122.800'} MHz</span></div>
            </div>
        `;
        flightsListEl.appendChild(li);
    });
}

function updateMap(flights, atcs) {
    const currentFlightIds = new Set();

    flights.forEach(flight => {
        // Use a combination of airline and flight number as unique ID if possible
        const id = `${flight.airline}-${flight.flight_number}`;
        currentFlightIds.add(id);

        if (planeMarkers.has(id)) {
            // Update existing marker
            const marker = planeMarkers.get(id);
            marker.setLatLng([flight.lat, flight.lon]);
            
            // Update rotation
            const iconEl = marker.getElement();
            if (iconEl) {
                // Leaflet DivIcon inner html wrapper
                iconEl.innerHTML = `<div class="plane-icon-container" style="transform: rotate(${flight.heading}deg)">${planeSvg}</div>`;
            }
            
            // Update popups dynamically
            marker.bindPopup(`<b>${flight.airline} ${flight.flight_number}</b><br>Od: ${flight.departure}<br>Do: ${flight.destination}<br>Alt: ${Math.round(flight.alt)} ft`);
            
            // Update lines if this is the selected flight
            if (selectedFlightId === id) {
                drawFlightLines(flight);
            }
        } else {
            // Create new marker
            // Custom DivIcon for rotation
            const customIcon = L.divIcon({
                html: `<div class="plane-icon-container" style="transform: rotate(${flight.heading}deg)">${planeSvg}</div>`,
                className: '', // remove default leaflet background
                iconSize: [32, 32],
                iconAnchor: [16, 16] // Center of the 32x32 container
            });

            const marker = L.marker([flight.lat, flight.lon], { icon: customIcon }).addTo(map);
            marker.bindPopup(`<b>${flight.airline} ${flight.flight_number}</b><br>Od: ${flight.departure}<br>Do: ${flight.destination}<br>Alt: ${Math.round(flight.alt)} ft`);
            
            marker.on('click', () => {
                selectedFlightId = id;
                drawFlightLines(flight);
            });

            planeMarkers.set(id, marker);
        }
        
        // Ensure existing markers have the click event attached correctly 
        // (if it wasn't there or to override with the latest flight data object)
        if (planeMarkers.has(id)) {
            const m = planeMarkers.get(id);
            m.off('click');
            m.on('click', () => {
                selectedFlightId = id;
                drawFlightLines(flight);
            });
        }
    });

    // Remove markers that are no longer in the active flights list
    for (const [id, marker] of planeMarkers.entries()) {
        if (!currentFlightIds.has(id)) {
            map.removeLayer(marker);
            planeMarkers.delete(id);
            if (selectedFlightId === id) {
                clearFlightLines();
                selectedFlightId = null;
            }
        }
    }

    // Process ATCs
    const atcsByAirport = new Map(); // key: airport, value: list of atc objects
    atcs.forEach(atc => {
        if (!atcsByAirport.has(atc.airport)) atcsByAirport.set(atc.airport, []);
        atcsByAirport.get(atc.airport).push(atc);
    });

    const currentAirportIds = new Set(atcsByAirport.keys());

    atcsByAirport.forEach((controllers, airport) => {
        const count = controllers.length;
        const callsigns = controllers.map(c => `<b>${c.callsign}</b> <span style="color: #45a29e;">(${c.freq ? parseFloat(c.freq).toFixed(3) : '118.000'} MHz)</span>`).join('<br>');
        const lat = controllers[0].lat;
        const lon = controllers[0].lon;

        if (atcMarkers.has(airport)) {
            const marker = atcMarkers.get(airport);
            marker.setLatLng([lat, lon]);
            marker.getPopup().setContent(`<b>Lotnisko ${airport}</b><br>Zalogowani ATC (${count}):<br>${callsigns}`);
            // Update badge text
            const iconEl = marker.getElement();
            if (iconEl) {
                const badge = iconEl.querySelector('.atc-badge');
                if (badge) badge.innerText = count;
            }
        } else {
            const customIcon = L.divIcon({
                html: `
                    <div class="atc-icon-container">
                        ${atcSvg}
                        <div class="atc-badge">${count}</div>
                        <div class="atc-label">${airport}</div>
                    </div>
                `,
                className: '',
                iconSize: [40, 40],
                iconAnchor: [20, 20]
            });

            const marker = L.marker([lat, lon], { icon: customIcon }).addTo(map);
            marker.bindPopup(`<b>Lotnisko ${airport}</b><br>Zalogowani ATC (${count}):<br>${callsigns}`);
            atcMarkers.set(airport, marker);
        }
    });

    for (const [airport, marker] of atcMarkers.entries()) {
        if (!currentAirportIds.has(airport)) {
            map.removeLayer(marker);
            atcMarkers.delete(airport);
        }
    }
}

function clearFlightLines() {
    if (activeFlightLine) {
        map.removeLayer(activeFlightLine);
        activeFlightLine = null;
    }
    if (activeDestinationLine) {
        map.removeLayer(activeDestinationLine);
        activeDestinationLine = null;
    }
}

function drawFlightLines(flight) {
    clearFlightLines();
    
    // Draw past path
    if (flight.path && flight.path.length > 0) {
        activeFlightLine = L.polyline(flight.path, {color: '#66fcf1', weight: 3}).addTo(map);
    }
    
    // Draw dashed line to destination
    if (flight.arr_lat !== 0 && flight.arr_lon !== 0) {
        activeDestinationLine = L.polyline(
            [[flight.lat, flight.lon], [flight.arr_lat, flight.arr_lon]], 
            {color: '#45a29e', weight: 2, dashArray: '10, 10'}
        ).addTo(map);
    }
}


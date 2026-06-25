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
let activePlannedRouteLine = null;
let activeWaypointMarkers = [];
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
        
        // Add a click listener to pan to the plane and show panel
        li.style.cursor = 'pointer';
        li.onclick = () => {
            const id = `${flight.airline}-${flight.flight_number}`;
            map.flyTo([flight.lat, flight.lon], 10, {
                animate: true,
                duration: 1.5
            });
            selectedFlightId = id;
            drawFlightLines(flight);
            showRightPanel(flight);
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

function getAircraftScale(type) {
    if (!type) return 1.0;
    type = type.toUpperCase();
    // Very Large
    if (['A388', 'A380', 'B748', 'B744', 'A124', 'A225'].includes(type)) return 1.8;
    // Large
    if (['B789', 'B788', 'B78X', 'B77W', 'B77L', 'B772', 'B773', 'A333', 'A332', 'A339', 'A359', 'A35K', 'B763'].includes(type)) return 1.4;
    // Small
    if (['C172', 'C152', 'PA28', 'SR22', 'TBM9', 'PC12', 'C208', 'DA40', 'DA62'].includes(type)) return 0.7;
    // Medium (Default)
    return 1.0;
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
            
            // Update rotation and size
            const iconEl = marker.getElement();
            if (iconEl) {
                const scale = getAircraftScale(flight.aircraft_type);
                iconEl.innerHTML = `<div class="plane-icon-container" style="transform: rotate(${flight.heading}deg) scale(${scale})">${planeSvg}</div>`;
            }
            
            // Update popups dynamically
            marker.bindPopup(`<b>${flight.airline} ${flight.flight_number}</b><br>Od: ${flight.departure}<br>Do: ${flight.destination}<br>Alt: ${Math.round(flight.alt)} ft`);
            
            // Update lines if this is the selected flight
            if (selectedFlightId === id) {
                drawFlightLines(flight);
                updateRightPanel(flight);
            }
        } else {
            // Create new marker
            // Custom DivIcon for rotation and scale
            const scale = getAircraftScale(flight.aircraft_type);
            const customIcon = L.divIcon({
                html: `<div class="plane-icon-container" style="transform: rotate(${flight.heading}deg) scale(${scale})">${planeSvg}</div>`,
                className: '', // remove default leaflet background
                iconSize: [32, 32],
                iconAnchor: [16, 16] // Center of the 32x32 container
            });

            const marker = L.marker([flight.lat, flight.lon], { icon: customIcon }).addTo(map);
            marker.bindPopup(`<b>${flight.airline} ${flight.flight_number}</b><br>Od: ${flight.departure}<br>Do: ${flight.destination}<br>Alt: ${Math.round(flight.alt)} ft`);
            
            marker.on('click', () => {
                selectedFlightId = id;
                drawFlightLines(flight);
                showRightPanel(flight);
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
                showRightPanel(flight);
            });
        }
    });

    // Remove markers that are no longer in the active flights list
    for (const [id, marker] of planeMarkers.entries()) {
        if (!currentFlightIds.has(id)) {
            map.removeLayer(marker);
            planeMarkers.delete(id);
            if (selectedFlightId === id) {
                hideRightPanel();
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

function clearPlannedRoute() {
    if (activePlannedRouteLine) {
        map.removeLayer(activePlannedRouteLine);
        activePlannedRouteLine = null;
    }
    activeWaypointMarkers.forEach(marker => map.removeLayer(marker));
    activeWaypointMarkers = [];
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
    clearPlannedRoute();
}

function drawFlightLines(flight) {
    clearFlightLines();
    
    // Draw past path with smooth altitude gradient
    if (flight.path && flight.path.length > 0) {
        const hotlineCoords = flight.path.map(p => {
            const alt = p[2] !== undefined ? p[2] : (flight.alt || 0);
            return [p[0], p[1], alt];
        });

        activeFlightLine = L.hotline(hotlineCoords, {
            min: 0,
            max: 40000,
            palette: {
                0.0: '#ffffff',   // White (0 ft)
                0.125: '#ffffff', // White (up to 5,000 ft)
                0.126: '#00c6ff', // Transition to Sky Blue (above 5,000 ft)
                0.25: '#00ff87',  // Neon Green (10,000 ft)
                0.50: '#f9d423',  // Neon Yellow (20,000 ft)
                0.75: '#ff4e50',  // Coral Red (30,000 ft)
                1.0: '#ff007f'    // Magenta / Pink (40,000+ ft)
            },
            weight: 3, // Thinner line as requested
            outlineColor: '#0b0c10',
            outlineWidth: 1
        }).addTo(map);
    }
    
    // Draw planned route (transparent light blue) and waypoint markers
    if (flight.planned_route && flight.planned_route.length > 0) {
        const plannedCoords = flight.planned_route.map(w => [w.lat, w.lon]);
        activePlannedRouteLine = L.polyline(plannedCoords, {
            color: '#00d2ff',
            weight: 2.5,
            opacity: 0.45
        }).addTo(map);

        flight.planned_route.forEach(w => {
            const customIcon = L.divIcon({
                html: `
                    <div class="waypoint-container">
                        <div class="waypoint-square"></div>
                        <div class="waypoint-label">${w.ident}</div>
                    </div>
                `,
                className: '',
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });

            const marker = L.marker([w.lat, w.lon], { icon: customIcon }).addTo(map);
            activeWaypointMarkers.push(marker);
        });
    } else {
        // Fallback: Draw dashed line to destination if no planned route
        if (flight.arr_lat !== 0 && flight.arr_lon !== 0) {
            activeDestinationLine = L.polyline(
                [[flight.lat, flight.lon], [flight.arr_lat, flight.arr_lon]], 
                {color: '#45a29e', weight: 2, dashArray: '10, 10'}
            ).addTo(map);
        }
    }
}

function showRightPanel(flight) {
    const panel = document.getElementById('right-panel');
    panel.classList.remove('hidden');
    updateRightPanel(flight);
}

function hideRightPanel() {
    const panel = document.getElementById('right-panel');
    panel.classList.add('hidden');
    selectedFlightId = null;
    clearFlightLines();
}

function updateRightPanel(flight) {
    const contentEl = document.getElementById('panel-content');
    if (!contentEl) return;
    
    const squawk = flight.transponder || '1200';
    
    let routeHtml = '<p class="no-route">Brak zaplanowanej trasy SimBrief</p>';
    if (flight.planned_route && flight.planned_route.length > 0) {
        routeHtml = `
            <div class="route-list">
                ${flight.planned_route.map((w, index) => `
                    <div class="route-waypoint">
                        <span class="waypoint-idx">${index + 1}</span>
                        <span class="waypoint-ident">${w.ident}</span>
                        <span class="waypoint-coords">${w.lat.toFixed(4)}, ${w.lon.toFixed(4)}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }

    contentEl.innerHTML = `
        <h2 class="panel-title">${flight.airline} ${flight.flight_number}</h2>
        <div class="panel-route">${flight.departure} ➔ ${flight.destination}</div>
        
        <div class="panel-section-title">Parametry lotu</div>
        <div class="panel-stats-grid">
            <div class="panel-stat-item">
                <span class="stat-label">Wysokość</span>
                <span class="stat-val">${Math.round(flight.alt)} ft</span>
            </div>
            <div class="panel-stat-item">
                <span class="stat-label">Kierunek</span>
                <span class="stat-val">${Math.round(flight.heading)}°</span>
            </div>
            <div class="panel-stat-item">
                <span class="stat-label">COM1</span>
                <span class="stat-val highlight-freq">${flight.com1_freq ? flight.com1_freq.toFixed(3) : '122.800'} MHz</span>
            </div>
            <div class="panel-stat-item">
                <span class="stat-label">Transponder</span>
                <span class="stat-val highlight-squawk">${squawk}</span>
            </div>
        </div>

        <div class="panel-section-title">Trasa SimBrief</div>
        ${routeHtml}
    `;
}


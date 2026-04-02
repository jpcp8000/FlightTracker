let map;
let tileLayer        = null;
let weatherTileLayer = null;
let owmApiKey        = null;
let flightMarkers    = {};
let flightTrails     = {};   // callsign → Leaflet polyline
let positionHistory  = {};   // callsign → [[lat, lon], ...]
let airportMarkers   = {};
let followedCallsign = null;
let followPanning    = false;
let flightFilter     = '';
let lastPosition     = {}; // key → {lat, lon, heading, status} for skip-unchanged

const MAX_TRAIL_POINTS = 200; // ~10 min at 3-sec refresh

// Use icao24 as the unique key per aircraft; fall back to callsign if missing
function flightKey(f) {
    return f.icao24 || f.callsign || 'unknown';
}
let currentAirport = localStorage.getItem('lastAirport') || 'KPVU';

// ---- Theme ----

let isDark = localStorage.getItem('theme') !== 'light';
document.body.className = isDark ? 'dark' : 'light';
document.getElementById('theme-toggle').textContent = isDark ? '☀' : '🌙';

function getTileUrl(dark) {
    return dark
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
}

document.getElementById('theme-toggle').addEventListener('click', () => {
    isDark = !isDark;
    document.body.className = isDark ? 'dark' : 'light';
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    document.getElementById('theme-toggle').textContent = isDark ? '☀' : '🌙';
    if (map && tileLayer) {
        map.removeLayer(tileLayer);
        tileLayer = L.tileLayer(getTileUrl(isDark), {
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/">CARTO</a>',
            maxZoom: 18
        }).addTo(map);
        tileLayer.bringToBack();
        if (weatherTileLayer) weatherTileLayer.bringToFront();
    }
});

// ---- Settings (loaded from localStorage with defaults) ----

const FIELD_DEFAULTS = {
    callsign:     true,
    number:       false,
    airline:      false,
    registration: false,
    icao24:       false,
    squawk:       false,
    origin:       true,
    destination:  true,
    aircraft:     true,
    altitude:     true,
    speed:        true,
    heading:      true,
    status:       true,
    onground:     false,
    climbColors:        false,
    showTrails:         true,
    showAirports:       true,
    showLargeAirports:  true,
    showMediumAirports: true,
    showSmallAirports:  true,
    showWeather:        false,
};

const settings = {
    fields: Object.fromEntries(
        Object.entries(FIELD_DEFAULTS).map(([k, def]) => [
            k, localStorage.getItem('field_' + k) !== null
                ? localStorage.getItem('field_' + k) !== 'false'
                : def
        ])
    ),
    arrPast:        parseInt(localStorage.getItem('arr_past')        || '30'),
    arrFuture:      parseInt(localStorage.getItem('arr_future')      || '60'),
    depPast:        parseInt(localStorage.getItem('dep_past')        || '60'),
    depFuture:      parseInt(localStorage.getItem('dep_future')      || '30'),
    altMin:         parseInt(localStorage.getItem('alt_min')         || '0'),
    altMax:         parseInt(localStorage.getItem('alt_max')         || '60000'),
    weatherLayer:   localStorage.getItem('weather_layer')            || 'clouds_new',
    weatherOpacity: parseFloat(localStorage.getItem('weather_opacity') || '0.5'),
};

function saveSettings() {
    Object.keys(settings.fields).forEach(k =>
        localStorage.setItem('field_' + k, settings.fields[k])
    );
    localStorage.setItem('arr_past',        settings.arrPast);
    localStorage.setItem('arr_future',      settings.arrFuture);
    localStorage.setItem('dep_past',        settings.depPast);
    localStorage.setItem('dep_future',      settings.depFuture);
    localStorage.setItem('alt_min',         settings.altMin);
    localStorage.setItem('alt_max',         settings.altMax);
    localStorage.setItem('weather_layer',   settings.weatherLayer);
    localStorage.setItem('weather_opacity', settings.weatherOpacity);
}

// ---- Map setup ----

const DEFAULT_LAT = 40.6413;
const DEFAULT_LON = -73.7781;
initMap(DEFAULT_LAT, DEFAULT_LON);
document.getElementById('airport-input').value = currentAirport;

function initMap(lat, lon) {
    map = L.map('map', { zoomControl: true }).setView([lat, lon], 10);
    tileLayer = L.tileLayer(getTileUrl(isDark), {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/">CARTO</a>',
        maxZoom: 18
    }).addTo(map);

    let mapMoveTimer = null;
    map.on('moveend zoomend', () => {
        if (followPanning) return;
        clearTimeout(mapMoveTimer);
        mapMoveTimer = setTimeout(() => {
            refreshFlights();
            refreshAirportPins();
        }, 300);
    });
}

// ---- Weather overlay ----

function applyWeatherLayer() {
    if (weatherTileLayer) {
        map.removeLayer(weatherTileLayer);
        weatherTileLayer = null;
    }
    if (!settings.fields.showWeather || !owmApiKey || !map) return;
    weatherTileLayer = L.tileLayer(
        `https://tile.openweathermap.org/map/${settings.weatherLayer}/{z}/{x}/{y}.png?appid=${owmApiKey}`,
        { opacity: settings.weatherOpacity, maxZoom: 18 }
    ).addTo(map);
}

// Fetch OWM API key from Flask config endpoint
fetch('/api/config')
    .then(r => r.json())
    .then(cfg => {
        owmApiKey = cfg.owm_api_key || '';
        applyWeatherLayer();
        if (cfg.version) {
            document.getElementById('version-badge').textContent = `v${cfg.version}`;
        }
    })
    .catch(() => {});

// Weather controls
const weatherLayerSel     = document.getElementById('weather-layer');
const weatherOpacitySlider = document.getElementById('weather-opacity');
const weatherOpacityVal   = document.getElementById('weather-opacity-val');

weatherLayerSel.value         = settings.weatherLayer;
weatherOpacitySlider.value    = settings.weatherOpacity;
weatherOpacityVal.textContent = Math.round(settings.weatherOpacity * 100) + '%';

weatherLayerSel.addEventListener('change', () => {
    settings.weatherLayer = weatherLayerSel.value;
    saveSettings();
    applyWeatherLayer();
});

weatherOpacitySlider.addEventListener('input', () => {
    settings.weatherOpacity = parseFloat(weatherOpacitySlider.value);
    weatherOpacityVal.textContent = Math.round(settings.weatherOpacity * 100) + '%';
    saveSettings();
    if (weatherTileLayer) weatherTileLayer.setOpacity(settings.weatherOpacity);
});

// ---- Follow mode ----

function setFollow(key, label) {
    followedCallsign = key || null;
    const badge = document.getElementById('follow-badge');
    if (key) {
        document.getElementById('follow-label').textContent = `Following: ${label || key}`;
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

document.getElementById('follow-exit').addEventListener('click', () => setFollow(null));

// ---- Flight filter ----

document.getElementById('flight-filter').addEventListener('input', (e) => {
    flightFilter = e.target.value.trim().toUpperCase();
});

// Known helicopter ICAO type codes
const HELICOPTER_CODES = new Set([
    'AS50','AS55','AS32','AS35','AS65','AS3B',
    'B06','B07','B06T','B212','B214','B222','B230','B412','B427','B429','B430','B47G','B47J',
    'EC20','EC25','EC30','EC35','EC45','EC55','EC75',
    'H500','H60','H64','H1','H43','H47',
    'MD52','MD60','MD63','MD69',
    'R22','R44','R66',
    'S55','S58','S61','S64','S65','S70','S76','S92',
    'UH1','CH47','CH53','AH64',
    'MIL','MI8','MI17','MI24','MI26',
    'A109','A119','A139','A149','A169','A189',
    'NH90','NHV','SC7',
    'LYNX','PERS','ELEV',
]);

function isHelicopter(aircraftCode) {
    if (!aircraftCode) return false;
    return HELICOPTER_CODES.has(aircraftCode.toUpperCase());
}

function getPlaneColor(status, aircraftCode) {
    if (isHelicopter(aircraftCode)) return '#f0a500'; // always orange for helis
    if (settings.fields.climbColors) {
        if (status === 'climbing')   return '#3fb950'; // green
        if (status === 'descending') return '#f85149'; // red
        return '#58a6ff'; // blue for level
    }
    return '#f0a500'; // default yellow like FR24
}

function planeIcon(heading, aircraftCode, status) {
    const heli  = isHelicopter(aircraftCode);
    const color = getPlaneColor(status, aircraftCode);

    const svg = heli
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 100 100"
               style="transform: rotate(${heading}deg); filter: drop-shadow(0 0 3px rgba(0,0,0,0.8));">
               <rect x="10" y="44" width="80" height="6" rx="3" fill="${color}" stroke="#0d1117" stroke-width="2"/>
               <rect x="47" y="10" width="6" height="30" rx="3" fill="${color}" stroke="#0d1117" stroke-width="2"/>
               <ellipse cx="50" cy="58" rx="18" ry="24" fill="${color}" stroke="#0d1117" stroke-width="3"/>
               <rect x="46" y="75" width="8" height="20" rx="3" fill="${color}" stroke="#0d1117" stroke-width="2"/>
           </svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 100 100"
               style="transform: rotate(${heading}deg); filter: drop-shadow(0 0 3px rgba(0,0,0,0.8));">
               <polygon points="50,5 62,40 58,40 58,70 65,75 65,85 50,80 35,85 35,75 42,70 42,40 38,40"
                        fill="${color}" stroke="#0d1117" stroke-width="3"/>
               <polygon points="20,55 42,45 42,60" fill="${color}" stroke="#0d1117" stroke-width="2"/>
               <polygon points="80,55 58,45 58,60" fill="${color}" stroke="#0d1117" stroke-width="2"/>
           </svg>`;

    return L.divIcon({
        className: '',
        html: svg,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        popupAnchor: [0, -16]
    });
}

function buildPopup(f) {
    const s = settings.fields;

    let title = '';
    if (s.callsign && f.callsign) title += f.callsign;
    if (s.number && f.number)     title += (title ? ' &nbsp;·&nbsp; ' : '') + f.number;
    if (!title) title = f.callsign || f.number || 'Unknown';

    let html = `<span class="popup-callsign">${title}</span>`;

    if (s.airline && (f.airline_iata || f.airline_icao)) {
        html += `<span class="popup-detail">Airline: ${f.airline_iata || f.airline_icao}</span>`;
    }
    if (s.registration && f.registration) {
        html += `<span class="popup-detail">Reg: ${f.registration}</span>`;
    }
    if (s.aircraft && f.aircraft) {
        html += `<span class="popup-detail">Aircraft: ${f.aircraft}</span>`;
    }

    const route = [];
    if (s.origin && f.origin)           route.push(`From: ${f.origin}`);
    if (s.destination && f.destination) route.push(`To: ${f.destination}`);
    if (route.length) html += `<span class="popup-detail">${route.join(' &nbsp;·&nbsp; ')}</span>`;

    const flightData = [];
    if (s.altitude) flightData.push(`${f.altitude_ft.toLocaleString()} ft`);
    if (s.speed)    flightData.push(`${f.speed_mph} mph`);
    if (flightData.length) html += `<span class="popup-detail">${flightData.join(' &nbsp;·&nbsp; ')}</span>`;

    const nav = [];
    if (s.heading && f.heading !== null) nav.push(`Hdg ${f.heading}°`);
    if (s.status)  nav.push(f.status);
    if (nav.length) html += `<span class="popup-detail">${nav.join(' &nbsp;·&nbsp; ')}</span>`;

    if (s.onground) html += `<span class="popup-detail">${f.on_ground ? '🟡 On ground' : '🔵 Airborne'}</span>`;

    if (s.squawk && f.squawk)   html += `<span class="popup-detail">Squawk: ${f.squawk}</span>`;
    if (s.icao24 && f.icao24)   html += `<span class="popup-detail">ICAO24: ${f.icao24}</span>`;

    return html;
}

// ---- Airport pins ----

function airportIcon(type) {
    const color = type === 'large_airport' ? '#f0a500'
                : type === 'medium_airport' ? '#8b949e'
                : '#484f58';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="40" fill="${color}" stroke="#0d1117" stroke-width="8"/>
        <rect x="45" y="15" width="10" height="70" rx="4" fill="#0d1117"/>
        <rect x="15" y="40" width="70" height="10" rx="4" fill="#0d1117"/>
        <rect x="30" y="68" width="40" height="8" rx="3" fill="#0d1117"/>
    </svg>`;
    return L.divIcon({
        className: '',
        html: svg,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
        popupAnchor: [0, -12]
    });
}

async function refreshAirportPins() {
    if (!settings.fields.showAirports) {
        Object.values(airportMarkers).forEach(m => map.removeLayer(m));
        airportMarkers = {};
        return;
    }

    const b = map.getBounds();
    if (map.getZoom() < 7) {
        Object.values(airportMarkers).forEach(m => map.removeLayer(m));
        airportMarkers = {};
        return;
    }

    try {
        const res = await fetch(`/api/airports?lamin=${b.getSouth()}&lamax=${b.getNorth()}&lomin=${b.getWest()}&lomax=${b.getEast()}`);
        if (!res.ok) return;
        const airports = await res.json();

        const seenIcao = new Set();
        for (const a of airports) {
            const isLarge  = a.type === 'large_airport';
            const isMedium = a.type === 'medium_airport';
            const isSmall  = !isLarge && !isMedium;
            if (isLarge  && !settings.fields.showLargeAirports)  continue;
            if (isMedium && !settings.fields.showMediumAirports) continue;
            if (isSmall  && !settings.fields.showSmallAirports)  continue;

            seenIcao.add(a.icao);
            if (airportMarkers[a.icao]) continue;

            const marker = L.marker([a.lat, a.lon], { icon: airportIcon(a.type), zIndexOffset: -100 })
                .bindTooltip(a.name, { permanent: false, direction: 'top' })
                .addTo(map);

            marker.on('click', () => {
                const code = a.icao;
                currentAirport = code;
                localStorage.setItem('lastAirport', code);
                document.getElementById('airport-input').value = code;
                document.getElementById('arrivals-list').innerHTML = '<div class="empty-msg">Loading...</div>';
                document.getElementById('departures-list').innerHTML = '<div class="empty-msg">Loading...</div>';
                refreshAirport();
            });

            airportMarkers[a.icao] = marker;
        }

        for (const icao in airportMarkers) {
            if (!seenIcao.has(icao)) {
                map.removeLayer(airportMarkers[icao]);
                delete airportMarkers[icao];
            }
        }
    } catch (e) {
        console.error('Error refreshing airport pins:', e);
    }
}

// ---- Flight map refresh (every 10 seconds) ----

async function refreshFlights() {
    if (!map) return;
    try {
        const b = map.getBounds();
        const res = await fetch(`/api/flights?lamin=${b.getSouth()}&lamax=${b.getNorth()}&lomin=${b.getWest()}&lomax=${b.getEast()}`);
        if (!res.ok) return;
        const flights = await res.json();

        // Apply altitude filter (on-ground planes always pass) and callsign/airline filter
        const filtered = flights.filter(f => {
            if (!f.on_ground && (f.altitude_ft < settings.altMin || f.altitude_ft > settings.altMax)) return false;
            if (flightFilter) {
                const matchCallsign = (f.callsign || '').toUpperCase().includes(flightFilter);
                const matchAirline  = (f.airline_iata || f.airline_icao || '').toUpperCase().includes(flightFilter);
                const matchNumber   = (f.number || '').toUpperCase().includes(flightFilter);
                if (!matchCallsign && !matchAirline && !matchNumber) return false;
            }
            return true;
        });

        const seenKeys = new Set();

        for (const f of filtered) {
            if (f.lat === null || f.lon === null) continue;
            const key = flightKey(f);
            seenKeys.add(key);
            const popupHTML = buildPopup(f);

            const prev = lastPosition[key];
            const moved = !prev || prev.lat !== f.lat || prev.lon !== f.lon;
            const changed = !prev || prev.heading !== f.heading || prev.status !== f.status;

            if (flightMarkers[key]) {
                if (moved)   flightMarkers[key].setLatLng([f.lat, f.lon]);
                if (changed) flightMarkers[key].setIcon(planeIcon(f.heading, f.aircraft, f.status));
                if (moved || changed) flightMarkers[key].setPopupContent(popupHTML);
                flightMarkers[key]._flightData = { heading: f.heading, aircraft: f.aircraft, status: f.status };
            } else {
                const marker = L.marker([f.lat, f.lon], { icon: planeIcon(f.heading, f.aircraft, f.status) })
                    .bindPopup(popupHTML)
                    .addTo(map);
                marker._flightData = { heading: f.heading, aircraft: f.aircraft, status: f.status };
                marker.on('click', () => setFollow(key, f.callsign));
                flightMarkers[key] = marker;
            }

            lastPosition[key] = { lat: f.lat, lon: f.lon, heading: f.heading, status: f.status };

            // Pan to followed plane
            if (followedCallsign === key && moved) {
                followPanning = true;
                map.panTo([f.lat, f.lon], { animate: true, duration: 0.5 });
                setTimeout(() => { followPanning = false; }, 600);
            }

            // Update position history and trail only when the plane actually moved
            if (moved) {
                if (!positionHistory[key]) positionHistory[key] = [];
                const hist = positionHistory[key];
                hist.push([f.lat, f.lon]);
                if (hist.length > MAX_TRAIL_POINTS) hist.shift();

                if (settings.fields.showTrails && hist.length >= 2) {
                    const color = getPlaneColor(f.status, f.aircraft);
                    if (flightTrails[key]) {
                        flightTrails[key].setLatLngs(hist);
                        if (changed) flightTrails[key].setStyle({ color });
                    } else {
                        flightTrails[key] = L.polyline(hist, {
                            color,
                            weight: 1.5,
                            opacity: 0.5,
                            interactive: false
                        }).addTo(map);
                        flightTrails[key].bringToBack();
                    }
                }
            }

            if (!settings.fields.showTrails && flightTrails[key]) {
                map.removeLayer(flightTrails[key]);
                delete flightTrails[key];
            }
        }

        for (const key in flightMarkers) {
            if (!seenKeys.has(key)) {
                map.removeLayer(flightMarkers[key]);
                delete flightMarkers[key];
                if (flightTrails[key]) {
                    map.removeLayer(flightTrails[key]);
                    delete flightTrails[key];
                }
                delete positionHistory[key];
                delete lastPosition[key];
                if (followedCallsign === key) setFollow(null);
            }
        }

        // If followed plane is filtered out this cycle, clear follow
        if (followedCallsign && !seenKeys.has(followedCallsign)) setFollow(null);

        const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        document.getElementById('map-status').textContent =
            `${filtered.length} flights visible · updated ${now}`;

        // Update header stats (based on all airborne flights from filtered set)
        const airborne   = filtered.filter(f => !f.on_ground);
        const highest    = airborne.reduce((best, f) => f.altitude_ft > (best?.altitude_ft ?? 0) ? f : best, null);
        const fastest    = airborne.reduce((best, f) => f.speed_mph   > (best?.speed_mph   ?? 0) ? f : best, null);
        const climbing   = airborne.filter(f => f.status === 'climbing').length;
        const descending = airborne.filter(f => f.status === 'descending').length;
        const level      = airborne.filter(f => f.status === 'level').length;

        document.getElementById('stat-count').textContent      = filtered.length;
        document.getElementById('stat-highest').textContent    = highest  ? `${highest.altitude_ft.toLocaleString()} ft` : '--';
        document.getElementById('stat-fastest').textContent    = fastest  ? `${fastest.speed_mph} mph` : '--';
        document.getElementById('stat-climbing').textContent   = climbing;
        document.getElementById('stat-descending').textContent = descending;
        document.getElementById('stat-level').textContent      = level;
    } catch (e) {
        console.error('Error refreshing flights:', e);
    }
}

// ---- Airport arrivals/departures refresh (every 60 seconds) ----

function fmtMins(m) {
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
}

function fmtAlt(ft) {
    return ft.toLocaleString() + ' ft';
}

function updateSubtitles() {
    document.getElementById('arr-subtitle').textContent =
        `last ${fmtMins(settings.arrPast)} · next ${fmtMins(settings.arrFuture)}`;
    document.getElementById('dep-subtitle').textContent =
        `last ${fmtMins(settings.depPast)} · next ${fmtMins(settings.depFuture)}`;
}

// ---- Toast ----

let toastTimer = null;
function showToast(msg, duration = 3000) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

// ---- Flash a marker to highlight it ----

function flashMarker(key) {
    const marker = flightMarkers[key];
    if (!marker) return;

    const flashIcon = (on) => {
        const f = marker._flightData;
        if (!f) return;
        if (on) {
            marker.setIcon(L.divIcon({
                className: '',
                html: `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 100 100"
                           style="transform: rotate(${f.heading}deg); filter: drop-shadow(0 0 6px #fff);">
                           <polygon points="50,5 62,40 58,40 58,70 65,75 65,85 50,80 35,85 35,75 42,70 42,40 38,40"
                                    fill="#ffffff" stroke="#0d1117" stroke-width="3"/>
                           <polygon points="20,55 42,45 42,60" fill="#ffffff" stroke="#0d1117" stroke-width="2"/>
                           <polygon points="80,55 58,45 58,60" fill="#ffffff" stroke="#0d1117" stroke-width="2"/>
                       </svg>`,
                iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -18]
            }));
        } else {
            marker.setIcon(planeIcon(f.heading, f.aircraft, f.status));
        }
    };

    let count = 0;
    const interval = setInterval(() => {
        flashIcon(count % 2 === 0);
        count++;
        if (count >= 8) {
            clearInterval(interval);
            flashIcon(false);
        }
    }, 400);
}

// ---- Locate flight from arrivals/departures panel ----

async function locateFlight(callsign) {
    showToast(`Locating ${callsign}…`, 10000);
    try {
        const res = await fetch(`/api/locate?callsign=${encodeURIComponent(callsign)}`);
        const d = await res.json();
        if (d.found) {
            showToast(`Found ${callsign} — panning to location`);
            map.setView([d.lat, d.lon], Math.max(map.getZoom(), 8));
            await refreshFlights();
            if (d.icao24) flashMarker(d.icao24);
        } else {
            showToast(`${callsign} is not currently trackable`);
        }
    } catch (e) {
        showToast('Could not locate flight');
    }
}

async function refreshAirport() {
    if (!currentAirport) return;
    const arrList = document.getElementById('arrivals-list');
    const depList = document.getElementById('departures-list');

    try {
        const url = `/api/airport?code=${currentAirport}&arr_past=${settings.arrPast}&arr_future=${settings.arrFuture}&dep_past=${settings.depPast}&dep_future=${settings.depFuture}`;
        const res = await fetch(url);
        if (!res.ok) {
            arrList.innerHTML = '<div class="empty-msg">Error loading data</div>';
            depList.innerHTML = '<div class="empty-msg">Error loading data</div>';
            return;
        }
        const data = await res.json();

        arrList.innerHTML = data.arrivals.length === 0
            ? '<div class="empty-msg">No arrivals in this window</div>'
            : data.arrivals.map(a => `
                <div class="flight-row clickable" data-callsign="${a.callsign}">
                    <div class="flight-callsign">${a.callsign}</div>
                    <div class="flight-detail">From: ${a.from}</div>
                    <div class="flight-detail">${a.time} &nbsp;·&nbsp; <span class="${statusClass(a.status)}">${a.status}</span></div>
                </div>`).join('');

        depList.innerHTML = data.departures.length === 0
            ? '<div class="empty-msg">No departures in this window</div>'
            : data.departures.map(d => `
                <div class="flight-row clickable" data-callsign="${d.callsign}">
                    <div class="flight-callsign">${d.callsign}</div>
                    <div class="flight-detail">To: ${d.to}</div>
                    <div class="flight-detail">${d.time} &nbsp;·&nbsp; <span class="${statusClass(d.status)}">${d.status}</span></div>
                </div>`).join('');
    } catch (e) {
        console.error('Error refreshing airport:', e);
    }
}

function statusClass(status) {
    const s = (status || '').toLowerCase();
    if (s.includes('land') || s.includes('arrived')) return 'status-landed';
    if (s.includes('route') || s.includes('air') || s.includes('departed')) return 'status-enroute';
    return 'status-scheduled';
}

// ---- Settings panel ----

document.querySelectorAll('[data-field]').forEach(cb => {
    cb.checked = settings.fields[cb.dataset.field];
    cb.addEventListener('change', () => {
        settings.fields[cb.dataset.field] = cb.checked;
        saveSettings();
        if (['showAirports','showLargeAirports','showMediumAirports','showSmallAirports'].includes(cb.dataset.field)) {
            Object.values(airportMarkers).forEach(m => map.removeLayer(m));
            airportMarkers = {};
            refreshAirportPins();
        }
        if (cb.dataset.field === 'showTrails' && !cb.checked) {
            Object.values(flightTrails).forEach(t => map.removeLayer(t));
            flightTrails = {};
        }
        if (cb.dataset.field === 'showWeather') {
            applyWeatherLayer();
        }
    });
});

function initSlider(id, valId, settingKey, formatter, onchange) {
    const slider = document.getElementById(id);
    const label  = document.getElementById(valId);
    slider.value = settings[settingKey];
    label.textContent = formatter(settings[settingKey]);
    slider.addEventListener('input', () => {
        settings[settingKey] = parseInt(slider.value);
        label.textContent = formatter(settings[settingKey]);
        saveSettings();
        if (onchange) onchange();
    });
}

initSlider('arr-past',   'arr-past-val',   'arrPast',   fmtMins, () => { updateSubtitles(); refreshAirport(); });
initSlider('arr-future', 'arr-future-val', 'arrFuture', fmtMins, () => { updateSubtitles(); refreshAirport(); });
initSlider('dep-past',   'dep-past-val',   'depPast',   fmtMins, () => { updateSubtitles(); refreshAirport(); });
initSlider('dep-future', 'dep-future-val', 'depFuture', fmtMins, () => { updateSubtitles(); refreshAirport(); });

// Altitude filter sliders
const altMinSlider = document.getElementById('alt-min');
const altMaxSlider = document.getElementById('alt-max');
const altMinVal    = document.getElementById('alt-min-val');
const altMaxVal    = document.getElementById('alt-max-val');

altMinSlider.value    = settings.altMin;
altMaxSlider.value    = settings.altMax;
altMinVal.textContent = fmtAlt(settings.altMin);
altMaxVal.textContent = fmtAlt(settings.altMax);

altMinSlider.addEventListener('input', () => {
    settings.altMin = parseInt(altMinSlider.value);
    if (settings.altMin > settings.altMax) {
        settings.altMax = settings.altMin;
        altMaxSlider.value    = settings.altMax;
        altMaxVal.textContent = fmtAlt(settings.altMax);
    }
    altMinVal.textContent = fmtAlt(settings.altMin);
    saveSettings();
});

altMaxSlider.addEventListener('input', () => {
    settings.altMax = parseInt(altMaxSlider.value);
    if (settings.altMax < settings.altMin) {
        settings.altMin = settings.altMax;
        altMinSlider.value    = settings.altMin;
        altMinVal.textContent = fmtAlt(settings.altMin);
    }
    altMaxVal.textContent = fmtAlt(settings.altMax);
    saveSettings();
});

document.getElementById('settings-toggle').addEventListener('click', () => {
    const body  = document.getElementById('settings-body');
    const arrow = document.getElementById('settings-arrow');
    body.classList.toggle('open');
    arrow.classList.toggle('open');
});

// ---- Airport search ----

document.getElementById('airport-btn').addEventListener('click', () => {
    const code = document.getElementById('airport-input').value.trim().toUpperCase();
    if (code.length >= 3) {
        currentAirport = code;
        localStorage.setItem('lastAirport', code);
        document.getElementById('arrivals-list').innerHTML = '<div class="empty-msg">Loading...</div>';
        document.getElementById('departures-list').innerHTML = '<div class="empty-msg">Loading...</div>';
        refreshAirport();
    }
});

document.getElementById('airport-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('airport-btn').click();
});

// ---- Sidebar resize ----

const handle     = document.getElementById('resize-handle');
const sidebar    = document.getElementById('sidebar');
const savedWidth = localStorage.getItem('sidebarWidth');
if (savedWidth) sidebar.style.width = savedWidth + 'px';

handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    const startX     = e.clientX;
    const startWidth = sidebar.offsetWidth;

    function onMove(e) {
        const newWidth = Math.min(600, Math.max(200, startWidth - (e.clientX - startX)));
        sidebar.style.width = newWidth + 'px';
        map.invalidateSize();
    }

    function onUp() {
        handle.classList.remove('dragging');
        localStorage.setItem('sidebarWidth', sidebar.offsetWidth);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
});

// ---- Start / location ----

let refreshFlightsInterval = null;
let refreshAirportInterval = null;

function start(lat, lon) {
    map.setView([lat, lon], 10);
    document.getElementById('airport-input').value = currentAirport;
    if (refreshFlightsInterval) clearInterval(refreshFlightsInterval);
    if (refreshAirportInterval) clearInterval(refreshAirportInterval);
    refreshFlights();
    refreshAirport();
    refreshAirportPins();
    refreshFlightsInterval = setInterval(refreshFlights, 3000);
    refreshAirportInterval = setInterval(refreshAirport, 60000);
}

document.getElementById('gps-btn').addEventListener('click', () => {
    document.getElementById('map-status').textContent = 'Detecting location...';
    fetch('/api/location')
        .then(r => r.json())
        .then(d => {
            if (d.lat && d.lon) start(d.lat, d.lon);
            else document.getElementById('map-status').textContent = 'Could not detect location';
        })
        .catch(() => {
            document.getElementById('map-status').textContent = 'Could not detect location';
        });
});

async function lookupZip() {
    const zip = document.getElementById('zip-input').value.trim();
    if (!zip) return;
    document.getElementById('map-status').textContent = 'Looking up zip code...';
    try {
        const res = await fetch(`/api/geocode?zip=${encodeURIComponent(zip)}`);
        if (!res.ok) {
            document.getElementById('map-status').textContent = 'Zip code not found';
            return;
        }
        const d = await res.json();
        start(d.lat, d.lon);
    } catch (e) {
        document.getElementById('map-status').textContent = 'Error looking up zip code';
    }
}

document.getElementById('zip-btn').addEventListener('click', lookupZip);
document.getElementById('zip-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') lookupZip();
});

// ---- Live clock ----
function updateClock() {
    document.getElementById('stat-time').textContent =
        new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
updateClock();
setInterval(updateClock, 1000);

// ---- Arrivals/departures click to locate ----

['arrivals-list', 'departures-list'].forEach(id => {
    document.getElementById(id).addEventListener('click', e => {
        const row = e.target.closest('.flight-row[data-callsign]');
        if (row) locateFlight(row.dataset.callsign);
    });
});

// ---- Init ----
updateSubtitles();
document.getElementById('map-status').textContent = 'Click "Detect My Location" or enter a zip code to start';

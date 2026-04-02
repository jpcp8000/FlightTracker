# Flight Tracker

A personal full-screen flight tracking dashboard built with Flask and Leaflet.js. Shows live overhead flights, airport arrivals/departures, weather overlays, and more.

![dark mode dashboard](https://via.placeholder.com/800x450?text=screenshot+here)

## Features

- **Live flight map** — fetches real-time flights for the current map view, refreshes every 10 seconds
- **Flight trails** — each plane draws a 10-minute position history trail behind it
- **Follow mode** — click any plane to lock the map onto it as it moves
- **Filter by callsign/airline** — type a prefix to narrow down visible planes (e.g. `SWA`, `UAL`, `N`)
- **Airport arrivals & departures** — search any ICAO airport code; configurable time windows
- **Airport pins** — large/medium/small airports shown on the map at zoom level 7+, click to load traffic
- **Weather overlay** — OpenWeatherMap tile layers (clouds, precipitation, wind, temperature, pressure) with adjustable opacity
- **Altitude filter** — hide ground traffic or restrict to a specific altitude band
- **Climb status coloring** — optionally color planes green (climbing), blue (level), red (descending)
- **Dark/light mode** — toggleable, persists across sessions
- **Resizable sidebar**
- **All settings saved to localStorage**

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/jpcp8000/FlightTracker.git
cd FlightTracker
```

### 2. Install dependencies

```bash
pip3 install -r requirements.txt
```

### 3. Download Leaflet locally

The app expects Leaflet files at `static/leaflet.js` and `static/leaflet.css`. Download them from [cdnjs](https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js):

```bash
curl -o static/leaflet.js https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js
curl -o static/leaflet.css https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css
```

### 4. Create a `.env` file

```
OPENWEATHER_API_KEY=your_key_here
```

Get a free API key at [openweathermap.org](https://openweathermap.org/api). The weather overlay won't work without it, but everything else will.

> The `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` fields are optional — OpenSky is included as a commented-out fallback data source.

### 5. Run

```bash
python3 app.py
```

Open `http://localhost:5002` in your browser.

## Data Sources

| Source | Used for |
|--------|----------|
| [FlightRadar24 unofficial API](https://github.com/JeanExtreme002/FlightRadarAPI) | Live flight positions, routes, airline data |
| [OurAirports](https://ourairports.com/data/) | Airport type classification (large/medium/small) |
| [airportsdata](https://github.com/mborsetti/airportsdata) | Airport lat/lon lookup |
| [OpenWeatherMap](https://openweathermap.org/api/weathermaps) | Weather tile overlays |
| [OpenStreetMap Nominatim](https://nominatim.org/) | Zip code geocoding |

## Notes

- Flight data is sourced from FlightRadar24's unofficial API. This is not an officially supported integration.
- Weather overlay requires a free OpenWeatherMap API key (new keys may take up to 2 hours to activate).
- The app runs on port `5002` by default to avoid conflicts with macOS AirPlay (5000) and common dev tools (5001).

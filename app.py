import time
import csv
import os
import requests
import geocoder
import airportsdata
from FlightRadar24 import FlightRadar24API
from flask import Flask, jsonify, render_template, request
from dotenv import load_dotenv

load_dotenv()

VERSION = "0.9.1-beta"

fr_api = FlightRadar24API()
app = Flask(__name__)

# Load OurAirports type data (large/medium/small) keyed by ICAO
def load_airport_types():
    types = {}
    csv_path = os.path.join(os.path.dirname(__file__), 'airports.csv')
    try:
        with open(csv_path, newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                if row.get('ident'):
                    types[row['ident']] = row.get('type', 'small_airport')
    except Exception as e:
        print(f"Warning: could not load airports.csv: {e}")
    return types

AIRPORT_TYPES = load_airport_types()
AIRPORTS_DB   = airportsdata.load("ICAO")

# ============================================================
# FLIGHTRADAR24
# ============================================================

def fmt_time(ts):
    if ts:
        return time.strftime("%I:%M %p", time.localtime(ts))
    return "Unknown"

def get_nearby_flights(lamin, lamax, lomin, lomax):
    try:
        bounds = fr_api.get_bounds({"tl_y": lamax, "tl_x": lomin, "br_y": lamin, "br_x": lomax})
        flights = fr_api.get_flights(bounds=bounds)
        result = []
        for f in flights:
            heading = round(f.heading) if f.heading is not None else 0
            if f.vertical_speed > 256:   status = "climbing"
            elif f.vertical_speed < -256: status = "descending"
            else:                         status = "level"
            result.append({
                "callsign":     f.callsign or "",
                "number":       f.number or "",
                "airline_iata": f.airline_iata or "",
                "airline_icao": f.airline_icao or "",
                "origin":       f.origin_airport_iata or "",
                "destination":  f.destination_airport_iata or "",
                "aircraft":     f.aircraft_code or "",
                "registration": f.registration or "",
                "squawk":       f.squawk or "",
                "icao24":       f.icao_24bit or "",
                "altitude_ft":  f.altitude,
                "speed_mph":    round(f.ground_speed * 1.151),
                "heading":      heading,
                "status":       status,
                "on_ground":    bool(f.on_ground),
                "lat":          f.latitude,
                "lon":          f.longitude
            })
        return result
    except Exception as e:
        print(f"FR24 error (nearby flights): {e}")
        return None

def get_airport_flights(airport_code, arr_past=30, arr_future=60, dep_past=60, dep_future=30):
    try:
        airport = fr_api.get_airport(airport_code, details=True)
    except Exception as e:
        print(f"FR24 error fetching airport: {e}")
        return None, None

    now = time.time()
    arr_start = now - (arr_past * 60)
    arr_end   = now + (arr_future * 60)
    dep_start = now - (dep_past * 60)
    dep_end   = now + (dep_future * 60)

    arrivals = []
    try:
        for item in airport.arrivals.get("data", []):
            flight = item["flight"]
            arr_time = (flight["time"]["real"]["arrival"]
                        or flight["time"]["scheduled"]["arrival"])
            if arr_time is None:
                continue
            if arr_start <= arr_time <= arr_end:
                origin = flight["airport"].get("origin") or {}
                origin_name = origin.get("name") or (origin.get("code") or {}).get("iata") or "Unknown"
                callsign = (flight["identification"]["callsign"]
                            or flight["identification"]["number"]["default"]
                            or "Unknown")
                arrivals.append({
                    "callsign": callsign,
                    "from": origin_name,
                    "time": fmt_time(arr_time),
                    "status": flight["status"]["text"] or "Unknown"
                })
    except Exception as e:
        print(f"Error parsing arrivals: {e}")

    departures = []
    try:
        for item in airport.departures.get("data", []):
            flight = item["flight"]
            dep_time = (flight["time"]["real"]["departure"]
                        or flight["time"]["scheduled"]["departure"])
            if dep_time is None:
                continue
            if dep_start <= dep_time <= dep_end:
                dest = flight["airport"].get("destination") or {}
                dest_name = dest.get("name") or (dest.get("code") or {}).get("iata") or "Unknown"
                callsign = (flight["identification"]["callsign"]
                            or flight["identification"]["number"]["default"]
                            or "Unknown")
                departures.append({
                    "callsign": callsign,
                    "to": dest_name,
                    "time": fmt_time(dep_time),
                    "status": flight["status"]["text"] or "Unknown"
                })
    except Exception as e:
        print(f"Error parsing departures: {e}")

    return arrivals, departures

# ============================================================
# FLASK ROUTES
# ============================================================

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/location')
def api_location():
    g = geocoder.ip('me')
    if g.ok:
        return jsonify({"lat": g.latlng[0], "lon": g.latlng[1]})
    return jsonify({"error": "Could not determine location"}), 500

@app.route('/api/geocode')
def api_geocode():
    zip_code = request.args.get('zip', '').strip()
    if not zip_code:
        return jsonify({"error": "zip required"}), 400
    resp = requests.get(
        "https://nominatim.openstreetmap.org/search",
        params={"postalcode": zip_code, "country": "US", "format": "json", "limit": 1},
        headers={"User-Agent": "FlightTrackerApp/1.0"}
    )
    if resp.status_code != 200 or not resp.json():
        return jsonify({"error": "Zip code not found"}), 404
    result = resp.json()[0]
    return jsonify({"lat": float(result["lat"]), "lon": float(result["lon"]), "name": result["display_name"]})

@app.route('/api/airports')
def api_airports():
    lamin = request.args.get('lamin', type=float)
    lamax = request.args.get('lamax', type=float)
    lomin = request.args.get('lomin', type=float)
    lomax = request.args.get('lomax', type=float)
    if None in (lamin, lamax, lomin, lomax):
        return jsonify({"error": "bounds required"}), 400

    results = []
    for icao, a in AIRPORTS_DB.items():
        lat, lon = a.get("lat"), a.get("lon")
        if lat is None or lon is None:
            continue
        if lamin <= lat <= lamax and lomin <= lon <= lomax:
            results.append({
                "icao": icao,
                "iata": a.get("iata", ""),
                "name": a.get("name", icao),
                "lat":  lat,
                "lon":  lon,
                "type": AIRPORT_TYPES.get(icao, "small_airport")
            })
    return jsonify(results)

@app.route('/api/flights')
def api_flights():
    lamin = request.args.get('lamin', type=float)
    lamax = request.args.get('lamax', type=float)
    lomin = request.args.get('lomin', type=float)
    lomax = request.args.get('lomax', type=float)
    if None in (lamin, lamax, lomin, lomax):
        return jsonify({"error": "lamin, lamax, lomin, lomax required"}), 400
    flights = get_nearby_flights(lamin, lamax, lomin, lomax)
    if flights is None:
        return jsonify({"error": "FR24 unavailable"}), 503
    return jsonify(flights)

@app.route('/api/airport')
def api_airport():
    code = request.args.get('code', '').strip().upper()
    if not code:
        return jsonify({"error": "airport code required"}), 400
    arr_past   = max(0, min(request.args.get('arr_past',   30,  type=int), 360))
    arr_future = max(0, min(request.args.get('arr_future', 60,  type=int), 360))
    dep_past   = max(0, min(request.args.get('dep_past',   60,  type=int), 360))
    dep_future = max(0, min(request.args.get('dep_future', 30,  type=int), 360))
    arrivals, departures = get_airport_flights(code, arr_past, arr_future, dep_past, dep_future)
    if arrivals is None:
        return jsonify({"error": "FR24 unavailable"}), 503
    return jsonify({"arrivals": arrivals, "departures": departures})

@app.route('/api/config')
def api_config():
    return jsonify({"owm_api_key": os.getenv("OPENWEATHER_API_KEY", ""), "version": VERSION})

if __name__ == '__main__':
    debug = os.getenv("FLASK_DEBUG", "false").lower() == "true"
    app.run(debug=debug, port=5002, threaded=True)

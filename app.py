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

# ============================================================
# OPENSKY FALLBACK (used if FlightRadar24 fails)
# ============================================================

# def get_access_token():
#     client_id = os.getenv("OPENSKY_CLIENT_ID")
#     client_secret = os.getenv("OPENSKY_CLIENT_SECRET")
#     token_url = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
#     response = requests.post(token_url, data={
#         "grant_type": "client_credentials",
#         "client_id": client_id,
#         "client_secret": client_secret
#     })
#     if response.status_code != 200:
#         print(f"Failed to get access token: {response.status_code} {response.text}")
#         return None
#     return response.json()["access_token"]

# def get_nearby_flights_opensky(lat, lon, token, radius_km=50):
#     offset = radius_km / 111
#     url = "https://opensky-network.org/api/states/all"
#     params = {
#         "lamin": lat - offset, "lamax": lat + offset,
#         "lomin": lon - offset, "lomax": lon + offset
#     }
#     headers = {"Authorization": f"Bearer {token}"}
#     response = requests.get(url, params=params, headers=headers)
#     if response.status_code != 200:
#         return []
#     data = response.json()
#     if data["states"] is None:
#         return []
#     flights = []
#     for state in data["states"]:
#         callsign = state[1].strip() if state[1] else "Unknown"
#         altitude_ft = round((state[7] or 0) * 3.281)
#         speed_mph = round((state[9] or 0) * 2.237)
#         heading = round(state[10]) if state[10] is not None else 0
#         vertical_rate = state[11] if state[11] is not None else 0
#         if vertical_rate > 1: status = "climbing"
#         elif vertical_rate < -1: status = "descending"
#         else: status = "level"
#         flights.append({"callsign": callsign, "altitude_ft": altitude_ft,
#                         "speed_mph": speed_mph, "heading": heading, "status": status,
#                         "lat": state[6], "lon": state[5]})
#     return flights

# def get_airport_flights_opensky(airport_code, token):
#     airports_db = airportsdata.load("ICAO")
#     airport = airports_db.get(airport_code.upper())
#     if airport is None:
#         return [], []
#     airport_lat, airport_lon = airport["lat"], airport["lon"]
#     offset = 5 / 111
#     params = {
#         "lamin": airport_lat - offset, "lamax": airport_lat + offset,
#         "lomin": airport_lon - offset, "lomax": airport_lon + offset
#     }
#     headers = {"Authorization": f"Bearer {token}"}
#     response = requests.get("https://opensky-network.org/api/states/all",
#                             params=params, headers=headers)
#     if response.status_code != 200:
#         return [], []
#     data = response.json()
#     if data["states"] is None:
#         return [], []
#     on_ground, in_air = [], []
#     for state in data["states"]:
#         callsign = state[1].strip() if state[1] else "Unknown"
#         altitude_ft = round((state[7] or 0) * 3.281)
#         speed_mph = round((state[9] or 0) * 2.237)
#         entry = {"callsign": callsign, "altitude_ft": altitude_ft, "speed_mph": speed_mph}
#         if state[8]: on_ground.append(entry)
#         else: in_air.append(entry)
#     return on_ground, in_air

# ============================================================
# FLIGHTRADAR24 (primary)
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
            if f.vertical_speed > 256: status = "climbing"
            elif f.vertical_speed < -256: status = "descending"
            else: status = "level"
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
    # Use OpenStreetMap Nominatim — free, no API key needed
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

    airports_db = airportsdata.load("ICAO")
    results = []
    for icao, a in airports_db.items():
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
        # Uncomment below to enable OpenSky fallback:
        # token = get_access_token()
        # if token: return jsonify(get_nearby_flights_opensky(lat, lon, token))
        return jsonify({"error": "FR24 unavailable"}), 503
    return jsonify(flights)

@app.route('/api/airport')
def api_airport():
    code = request.args.get('code', '').strip()
    if not code:
        return jsonify({"error": "airport code required"}), 400
    arr_past   = request.args.get('arr_past',   30,  type=int)
    arr_future = request.args.get('arr_future', 60,  type=int)
    dep_past   = request.args.get('dep_past',   60,  type=int)
    dep_future = request.args.get('dep_future', 30,  type=int)
    arrivals, departures = get_airport_flights(code, arr_past, arr_future, dep_past, dep_future)
    if arrivals is None:
        # Uncomment below to enable OpenSky fallback:
        # token = get_access_token()
        # if token:
        #     on_ground, in_air = get_airport_flights_opensky(code, token)
        #     return jsonify({"arrivals": on_ground, "departures": in_air})
        return jsonify({"error": "FR24 unavailable"}), 503
    return jsonify({"arrivals": arrivals, "departures": departures})

@app.route('/api/config')
def api_config():
    return jsonify({"owm_api_key": os.getenv("OPENWEATHER_API_KEY", "")})

if __name__ == '__main__':
    app.run(debug=True, port=5002, threaded=True)

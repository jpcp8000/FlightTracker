import time
import requests
import os
from dotenv import load_dotenv

load_dotenv()

def get_access_token():
    client_id = os.getenv("OPENSKY_CLIENT_ID")
    client_secret = os.getenv("OPENSKY_CLIENT_SECRET")
    response = requests.post(
        "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
        data={"grant_type": "client_credentials", "client_id": client_id, "client_secret": client_secret}
    )
    if response.status_code != 200:
        print(f"Auth failed: {response.status_code} {response.text}")
        return None
    return response.json()["access_token"]

token = get_access_token()
if not token:
    exit()

now = int(time.time())
twenty_four_hours_ago = now - 86400

response = requests.get(
    "https://opensky-network.org/api/flights/arrival",
    params={"airport": "KSLC", "begin": twenty_four_hours_ago, "end": now},
    headers={"Authorization": f"Bearer {token}"}
)

print(f"Status: {response.status_code}")
print(f"Raw response: {response.text[:500]}")

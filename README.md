# Strava Globe

Visualize every GPS activity you've ever logged on Strava — all at once, on one map.

## Setup

### 1. Create a Strava API app

1. Go to https://www.strava.com/settings/api
2. Fill in the form:
   - **Application Name**: Strava Globe (or anything)
   - **Website**: http://localhost
   - **Authorization Callback Domain**: `localhost`
3. Copy your **Client ID** and **Client Secret**

### 2. Get a Google Maps API key

1. Go to https://console.cloud.google.com/
2. Create a project (or select an existing one)
3. Enable the **Maps JavaScript API**
4. Create an API key under **APIs & Services → Credentials**

### 3. Configure the backend

```bash
cd backend
cp .env.example .env
# Edit .env with your Strava Client ID and Secret
npm install
npm run dev
```

### 4. Configure the frontend

```bash
cd frontend
cp .env.example .env
# Edit .env with your Google Maps API key
npm install
npm run dev
```

### 5. Open the app

Visit http://localhost:5173 and click **Connect with Strava**.

---

## How it works

1. **OAuth**: The backend handles Strava's OAuth 2.0 flow and stores tokens in a server-side session.
2. **Streaming fetch**: The backend pages through all your Strava activities (200 per request) and streams results back as newline-delimited JSON, so the map populates progressively.
3. **Polylines**: Each activity with GPS data has a `summary_polyline` (Google-encoded). These are decoded by the Maps Geometry library and drawn directly on the map.
4. **Token refresh**: Access tokens are automatically refreshed when they're about to expire.

## Project structure

```
strava-globe/
├── backend/
│   ├── server.js       # Express app: OAuth + activity streaming
│   ├── package.json
│   └── .env.example
└── frontend/
    ├── src/
    │   ├── App.jsx                       # Routing + auth state
    │   ├── components/
    │   │   ├── Landing.jsx               # Connect page
    │   │   └── MapView.jsx               # Map + header + filters
    │   └── hooks/
    │       └── useActivities.js          # NDJSON streaming hook
    ├── index.html
    ├── vite.config.js
    └── .env.example
```

# SG Smart Route

Traffic-aware fastest-route planner for Singapore.

## Run
1. Get a free AccountKey: https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html
2. `npm install`
3. `LTA_API_KEY=your_key npm start`  (Windows PowerShell: `$env:LTA_API_KEY="your_key"; npm start`)
4. Open http://localhost:3000

## How it works
- OSRM returns up to 4 candidate routes with per-segment distance and duration.
- The server downloads LTA `TrafficSpeedBands` v4 (~5 min refresh), indexes links in a spatial grid, and
  matches each route segment to the nearest link travelling in the same direction.
- Where live speed is below the free-flow speed, the segment time is scaled up. Nearby `TrafficIncidents`
  add a small time penalty. Routes are re-ranked by the live ETA.
- The chosen route is drawn in colour by speed band (LTA bands 1-8).

## Notes
- The OSRM public demo server is for light use only. For production, self-host OSRM (Malaysia/Singapore/Brunei
  extract from Geofabrik) and set `OSRM_URL`.
- OSRM has no knowledge of ERP gantries or tolls (LTA removed its ERPRates API in 2024).
- Keep your AccountKey on the server only; never ship it to the browser.

## Deploy online and install on iPhone (PWA)
1. Push this folder to a GitHub repo (`.env` is git-ignored, so your key stays private).
2. On https://render.com: New > Web Service > connect the repo.
   Build command `npm install`, start command `npm start` (or use the included `render.yaml`).
3. Add environment variable `LTA_API_KEY` = your DataMall key.
4. Open the `https://....onrender.com` address in **Safari** on your iPhone.
5. Tap Share > **Add to Home Screen**. It now opens full screen like an app.
Free Render services sleep when idle, so the first open after a break can take about a minute.

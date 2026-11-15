# LIFELINE

**When infrastructure fails, communities shouldn't.**

LIFELINE is a community emergency coordination app for situations where the internet or mobile network is unreliable. Nearby devices pair directly with each other, share emergency requests, and keep working offline. Each device stores what it knows locally and merges new information as it arrives.

> Prototype. LIFELINE does not contact emergency services. In an emergency, call 999.

## What it does

- **Create emergency requests** with category, urgency, number of people, location (typed, plus optional GPS) and a description.
- **Keep them on the device** in IndexedDB. Requests survive refreshes and work with no connection.
- **Show them on a map** and in a list, colour-coded by urgency.
- **Track status** (Open, Assigned, Resolved). Changes spread to paired devices and the newest change wins.
- **Pair devices without a server**: one device shows a QR code, the other scans it and shows an answer QR, and the first scans that. A paste-the-code fallback exists for every step.
- **Share between many devices**: each device can hold several direct links. New requests, status changes and previously saved requests are forwarded to every peer, and relayed onward (up to 6 hops), so devices that are not directly paired still see each other's requests.
- **Volunteers and resource matching**: each device can register one volunteer profile (name, kinds of help offered, area, availability). Profiles sync across paired devices like requests. Open requests show which available volunteers match their category, and you can **Assign** one. A volunteer can also see the open requests that match their skills (most urgent first) and **Take** one. Assigning sets the status to Assigned and shows who it is assigned to on every device. Reopening a request releases the volunteer. Each volunteer sets **how many people they can help at once**. The app counts the people in the requests currently assigned to them (Assigned only, so resolving a request frees their capacity), shows "Helping 4 of 5" on every device, and disables **Assign** / **Take this** when a request would put them over their limit. A warning shows when an open request has no available volunteer with the right skills and room.
- **AI triage**: while writing a request, press **Suggest category and urgency**. It suggests a category, urgency and number of people from the description. You review it and press Apply; nothing is changed automatically. It asks the LIFELINE server first (Gemini AI when the server has a key, otherwise keyword rules), and falls back to rules on the device when the server is not running or you are offline. The suggestion always says which one produced it.
- **Works with no network at all (Offline sync)**: when there is no Wi-Fi, hotspot or internet, devices exchange requests and volunteers using only a screen and a camera, or a file:
  - **QR:** one device shows its data as a looping series of QR codes; the other scans them (frames can be scanned in any order, repeats are ignored, a checksum rejects incomplete or mixed-up scans). Do it on both devices to share both ways.
  - **File:** *Save as file* produces a `.lifeline` file you can send with AirDrop, Nearby Share or Bluetooth (these work without internet); *Import a file* loads it on the other device.
  - **Code:** copy/paste the sync code.
  Imported items go through the same validation and merge rules as live ones (whitelisted fields, newest change wins, no duplicates), and are passed on to any devices linked at that moment.
- **Opens without a network**: a service worker caches the app after one online visit, so it can be reopened and refreshed with no connection. Map tiles you have viewed online are cached too.
- **Report delivery honestly**: a request shows "Delivered to X" only after X has saved it and sent back an acknowledgement. "Sent" is not "delivered".

## Quick start

Requires Node 20+.

```bash
cd lifeline
npm install
npm run dev          # app only
npm run dev:full     # app + triage server
```

Open http://localhost:5173. The app works without the server; only the "Suggest" button changes (it then uses on-device rules).

### Trying it with real devices

Phone cameras only work over HTTPS (or localhost), so use the tunnel:

```bash
npm run share:full       # terminal 1: builds, serves on :4173, and starts the triage server (use `npm run share` for the app alone)
npm run tunnel:share     # terminal 2: prints an https://….loca.lt link
```

Open the link on each device and **allow camera access when asked**. LIFELINE briefly opens the camera while it builds a pairing code, because browsers only reveal a device's real Wi-Fi address (instead of a hidden `.local` name) once the camera is allowed. Without it, devices on a phone hotspot usually fail to connect. On one, tap **Create pairing QR**. On the other, tap **Scan pairing QR**, scan it, then show the answer QR back to the first device. Devices on the same Wi-Fi or hotspot connect most reliably.

### Using it with no network at all

1. **While you still have internet**, open the `https://` link once on every device and let it finish loading (this installs the offline copy). Create or allow the camera if asked.
2. Later, with no network, open the same link or the installed page. It loads from the device.
3. On each device use **Offline sync**: *Show my data as QR* on one, *Scan another device* on the other, then swap. Or *Save as file* and send it by AirDrop / Nearby Share.

The camera needs HTTPS or localhost, which is why step 1 must use the `https://` tunnel link.

## Scripts (run inside `lifeline/`)

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on :5173 |
| `npm run build` | Production build |
| `npm run share` | Build and preview on :4173 |
| `npm run server` | Triage server on :3001 (the app proxies `/api` to it, so phones can use it through the tunnel) |
| `npm run dev:full` / `share:full` | App and server together |
| `npm run tunnel:share` | HTTPS tunnel to the preview server |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (validation, merging, messages, volunteers, matching, triage) |
| `npm run e2e` | Browser tests: two and three real Chrome instances pairing and exchanging requests. Needs Google Chrome and a prior `npm run build`. Set `CHROME_PATH` if Chrome is not in the default macOS location. |

## How it works

```
lifeline/src
├── App.jsx                 dashboard, request list, status changes, volunteers, incoming request handling
├── components/
│   ├── RequestForm.jsx     new request form (validation, optional GPS, double-submit guard)
│   ├── OfflineSync.jsx     network-free transfer: QR frames, file, pasted code
│   ├── VolunteerPanel.jsx  volunteer profile, matches, assignment UI
│   ├── EmergencyMap.jsx    Leaflet map, markers by urgency
│   └── NetworkPanel.jsx    owns every WebRTC peer and data channel, pairing UI, relay, ACKs
└── utils/
    ├── db.js               IndexedDB storage
    ├── requestSync.js      validation, merge rules, wire format, volunteer matching (unit tested)
    ├── offlineSync.js      sync code format, QR framing and reassembly (unit tested)
    ├── codec.js            compression + URL-safe encoding helpers
    ├── triage.js           category/urgency suggestions: server first, on-device rules as fallback
    └── peerConnection.js   offer/answer creation, ICE gathering, QR payload compression
```

- **Pairing** uses WebRTC data channels. QR codes carry the connection offer and answer, compressed to stay scannable. Google and Cloudflare STUN servers are used for address discovery. There is no TURN server.
- **Incoming requests** are validated (only whitelisted fields kept, text cleaned, sizes limited), merged by ID, saved, then acknowledged.
- **Duplicates** are dropped by request ID. When two copies differ, the one with the newer `updatedAt` wins.
- **Sample data**: four demo requests are seeded on first run, labelled "sample data", and never sent to other devices.

## What has been verified

- Unit tests, lint and production build pass.
- Browser tests (they start their own app and triage server on separate ports, so a running dev server is not affected). They run on one machine (real Chrome, pasted codes instead of camera scanning) cover: form validation, AI triage through the server and its offline fallback, volunteer registration and sync, matching, assignment, reopening, availability, double-click protection, persistence across refresh, two-device pairing, request transfer, acknowledgements, status sync, disconnect handling, a three-device relay chain, mobile layout without horizontal overflow.
- Confirmed by hand on real devices: a MacBook (Chrome) and an iPhone (Chrome) paired and connected over a phone hotspot.
- Browser tests with the network switched off: the app reloads from the service worker, requests and volunteers transfer in both directions by sync code and by file, duplicates and damaged codes are handled. The rendered QR image is decoded back with the same scanner library the app uses.
- **Not yet tested**: camera scanning of the looping QR on real phones (including how reliably a phone reads it off a laptop screen), AirDrop/Nearby Share transfer of the file, the offline app on iPhone Safari, more than two physical devices, devices on different networks.

## Known limits

- Offline sync is manual and one-way per scan: it is a snapshot (up to 50 newest shareable requests and 50 volunteers), not a live link. Live updates need a shared network.
- The offline copy exists only after one online visit to the `https://` link. Fonts and map tiles are cached only if viewed online first; otherwise offline the map background is blank (markers still show).
- Refreshing a page drops its peer links; devices must be paired again.
- Pairing needs camera permission (see above). There is no TURN relay, so devices on different networks or behind strict NAT may not connect. Wi-Fi with client isolation (some guest/university networks) will also block it.
- Anyone paired can change any request's status. There are no accounts or roles.
- Map tiles need internet access.
- Volunteer matching uses category, availability and capacity. It does not use distance. Capacity is counted by number of people, not by effort, and two devices that assign the same volunteer at the same moment can briefly push them over their limit; the list then shows "over capacity" instead of hiding it. Profiles created before this feature have no limit set until edited.
- Triage suggestions are keyword-based unless the server has a `GEMINI_API_KEY`. With a key, the request description is sent to Google's Gemini API. Set `GEMINI_MODEL` in `server/.env` if the default model name is not available to your key.
- `server/` (Express) provides `POST /api/triage` for the app. Its older `/api/reports` partition/reconcile simulation is not used by the app. To enable Gemini, put `GEMINI_API_KEY=...` in `server/.env` (git-ignored). Without a key it uses keyword rules.

## Roadmap

1. Test with more physical devices (three or more).
2. Reconnect without re-pairing.
3. Test offline QR/file sync on real phones, and add live proximity links where the hardware allows (Bluetooth/Wi-Fi Direct need a native app).
4. Distance-aware matching and volunteer capacity.

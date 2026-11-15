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
- **Report delivery honestly**: a request shows "Delivered to X" only after X has saved it and sent back an acknowledgement. "Sent" is not "delivered".

## Quick start

Requires Node 20+.

```bash
cd lifeline
npm install
npm run dev
```

Open http://localhost:5173.

### Trying it with real devices

Phone cameras only work over HTTPS (or localhost), so use the tunnel:

```bash
npm run share            # terminal 1: builds and serves on :4173
npm run tunnel:share     # terminal 2: prints an https://….loca.lt link
```

Open the link on each device and **allow camera access when asked**. LIFELINE briefly opens the camera while it builds a pairing code, because browsers only reveal a device's real Wi-Fi address (instead of a hidden `.local` name) once the camera is allowed. Without it, devices on a phone hotspot usually fail to connect. On one, tap **Create pairing QR**. On the other, tap **Scan pairing QR**, scan it, then show the answer QR back to the first device. Devices on the same Wi-Fi or hotspot connect most reliably.

## Scripts (run inside `lifeline/`)

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on :5173 |
| `npm run build` | Production build |
| `npm run share` | Build and preview on :4173 |
| `npm run tunnel:share` | HTTPS tunnel to the preview server |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (validation, merging, messages) |
| `npm run e2e` | Browser tests: two and three real Chrome instances pairing and exchanging requests. Needs Google Chrome and a prior `npm run build`. Set `CHROME_PATH` if Chrome is not in the default macOS location. |

## How it works

```
lifeline/src
├── App.jsx                 dashboard, request list, status changes, incoming request handling
├── components/
│   ├── RequestForm.jsx     new request form (validation, optional GPS, double-submit guard)
│   ├── EmergencyMap.jsx    Leaflet map, markers by urgency
│   └── NetworkPanel.jsx    owns every WebRTC peer and data channel, pairing UI, relay, ACKs
└── utils/
    ├── db.js               IndexedDB storage
    ├── requestSync.js      validation, merge rules, wire format (unit tested)
    └── peerConnection.js   offer/answer creation, ICE gathering, QR payload compression
```

- **Pairing** uses WebRTC data channels. QR codes carry the connection offer and answer, compressed to stay scannable. Google and Cloudflare STUN servers are used for address discovery. There is no TURN server.
- **Incoming requests** are validated (only whitelisted fields kept, text cleaned, sizes limited), merged by ID, saved, then acknowledged.
- **Duplicates** are dropped by request ID. When two copies differ, the one with the newer `updatedAt` wins.
- **Sample data**: four demo requests are seeded on first run, labelled "sample data", and never sent to other devices.

## What has been verified

- Unit tests, lint and production build pass.
- Browser tests on one machine (real Chrome, pasted codes instead of camera scanning) cover: form validation, double-click protection, persistence across refresh, two-device pairing, request transfer, acknowledgements, status sync, disconnect handling, a three-device relay chain, mobile layout without horizontal overflow.
- Confirmed by hand on real devices: a MacBook (Chrome) and an iPhone (Chrome) paired and connected over a phone hotspot.
- **Not yet tested**: more than two physical devices, devices on different networks.

## Known limits

- Refreshing a page drops its peer links; devices must be paired again.
- Pairing needs camera permission (see above). There is no TURN relay, so devices on different networks or behind strict NAT may not connect. Wi-Fi with client isolation (some guest/university networks) will also block it.
- Anyone paired can change any request's status. There are no accounts or roles.
- Map tiles need internet access.
- Volunteers and resource matching are not built yet.
- `server/` (Express with optional Gemini-based triage and a partition/reconcile simulation) is **not used by the frontend**. It is an early prototype for AI-assisted triage. To run it, copy your key into `server/.env` as `GEMINI_API_KEY` and run `node index.js` in `server/`. Without a key it falls back to keyword rules.

## Roadmap

1. Test with more physical devices (three or more).
2. Reconnect without re-pairing.
3. Connect the AI triage server to the app.
4. Volunteer and resource matching.
5. Offline map tiles.

import { useState, useEffect, useRef, useCallback } from "react";
import EmergencyMap from "./components/EmergencyMap";
import RequestForm from "./components/RequestForm";
import NetworkPanel from "./components/NetworkPanel";
import VolunteerPanel, { RequestMatches } from "./components/VolunteerPanel";
import OfflineSync from "./components/OfflineSync";
import {
  saveRequest,
  getRequest,
  getSavedRequests,
  saveVolunteer,
  getVolunteer,
  getSavedVolunteers,
} from "./utils/db";
import {
  decideMerge,
  formatRelativeTime,
  isShareable,
  mergeRequestLists,
  upsertRequest,
  validateRequest,
  withStatus,
  withAssignment,
  fitsCapacity,
  remainingCapacity,
  validateVolunteer,
  upsertVolunteer,
  mergeVolunteerLists,
  volunteerIdForDevice,
  STATUSES,
  MAX_SYNC_REQUESTS,
  MAX_SYNC_VOLUNTEERS,
} from "./utils/requestSync";

import { Heart, MapPin, Plus, Wifi, WifiOff } from "lucide-react";

// ---------------- INITIAL DEMO DATA ----------------
// Seeded once into an empty database. Never sent over the network.

const initialRequests = [
  {
    id: "SOS-104",
    name: "Household A",
    category: "Water supplies",
    location: "Camden",
    lat: 51.539,
    lng: -0.142,
    people: 3,
    urgency: "Critical",
    status: "Open",
    time: "2 min ago",
    source: "demo",
  },
  {
    id: "SOS-103",
    name: "Household B",
    category: "Medical assistance",
    location: "Kentish Town",
    lat: 51.55,
    lng: -0.141,
    people: 2,
    urgency: "High",
    status: "Assigned",
    time: "8 min ago",
    source: "demo",
  },
  {
    id: "SOS-102",
    name: "Household C",
    category: "Shelter",
    location: "Chalk Farm",
    lat: 51.545,
    lng: -0.157,
    people: 4,
    urgency: "Medium",
    status: "Open",
    time: "14 min ago",
    source: "demo",
  },
  {
    id: "SOS-101",
    name: "Household D",
    category: "Food supplies",
    location: "Camden",
    lat: 51.535,
    lng: -0.135,
    people: 2,
    urgency: "Low",
    status: "Resolved",
    time: "21 min ago",
    source: "demo",
  },
];

// ---------------- THIS DEVICE ----------------

function loadDevice() {
  const fallback = {
    id: Math.random().toString(36).slice(2, 10),
    name: `Device-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
  };
  try {
    const saved = JSON.parse(localStorage.getItem("lifeline-device") || "null");
    if (saved?.id && saved?.name) return saved;
    localStorage.setItem("lifeline-device", JSON.stringify(fallback));
  } catch {
    // Private mode etc. – a per-session identity is fine.
  }
  return fallback;
}

// ---------------- MAIN APP ----------------

function App() {
  const [requests, setRequests] = useState([]);
  const [formOpen, setFormOpen] = useState(false);
  const [transferStatus, setTransferStatus] = useState("");
  const [network, setNetwork] = useState({ peers: [], openCount: 0 });
  const [delivery, setDelivery] = useState({}); // id -> { state, ackedBy: [] }
  const [device, setDevice] = useState(loadDevice);
  const [now, setNow] = useState(() => Date.now());
  const [volunteers, setVolunteers] = useState([]);

  const requestsRef = useRef([]);
  const networkSenderRef = useRef(null); // registered by NetworkPanel
  const inFlightRef = useRef(new Set()); // incoming IDs currently being saved
  const savingIdsRef = useRef(new Set()); // locally created IDs already submitted
  const sectionRefs = useRef({});
  const volunteersRef = useRef([]);
  const volunteerSenderRef = useRef(null); // registered by NetworkPanel
  const inFlightVolunteersRef = useRef(new Set());

  // Single place that changes the request list, so the ref used by the
  // network code is always in sync with React state.
  const applyRequests = useCallback((update) => {
    setRequests((previous) => {
      const next = update(previous);
      requestsRef.current = next;
      return next;
    });
  }, []);

  const applyVolunteers = useCallback((update) => {
    setVolunteers((previous) => {
      const next = update(previous);
      volunteersRef.current = next;
      return next;
    });
  }, []);

  // Refresh "x min ago" labels.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  // ---------------- LOAD DATABASE ----------------
  // MERGES with whatever is already in state, so a request that arrived over
  // the network while the database was still loading is never lost.

  useEffect(() => {
    let cancelled = false;

    async function loadRequests() {
      let saved = [];
      try {
        saved = await getSavedRequests();
        if (saved.length === 0) {
          for (const request of initialRequests) await saveRequest(request);
          saved = initialRequests;
        }
      } catch (error) {
        console.error("Failed to load requests:", error);
        setTransferStatus("Could not open the local database. Requests will not survive a refresh.");
        saved = initialRequests;
      }
      if (!cancelled) applyRequests((current) => mergeRequestLists(saved, current));
    }

    loadRequests();
    return () => {
      cancelled = true;
    };
  }, [applyRequests]);

  // Volunteers load separately so a problem there never hides the requests.
  useEffect(() => {
    let cancelled = false;
    getSavedVolunteers()
      .then((saved) => {
        if (cancelled) return;
        const valid = saved.filter((item) => validateVolunteer(item).ok);
        applyVolunteers((current) => mergeVolunteerLists(valid, current));
      })
      .catch((error) => console.error("Failed to load volunteers:", error));
    return () => {
      cancelled = true;
    };
  }, [applyVolunteers]);

  // ---------------- RECEIVE EMERGENCY ----------------
  // Called by NetworkPanel for every SOS_REQUEST. Returns a result so the
  // panel knows whether to acknowledge and relay it.

  const handleIncomingRequest = useCallback(async (raw, meta = {}) => {
    const checked = validateRequest(raw);
    if (!checked.ok) {
      console.warn("Rejected incoming request:", checked.error);
      return { ok: false, error: checked.error };
    }

    const incoming = checked.request;

    // The same request can arrive from two peers at once (direct + relayed).
    if (inFlightRef.current.has(incoming.id)) {
      return { ok: true, status: "duplicate", request: incoming };
    }
    inFlightRef.current.add(incoming.id);

    try {
      const existing = await getRequest(incoming.id);
      const decision = decideMerge(existing, incoming);

      if (decision === "duplicate") {
        return { ok: true, status: "duplicate", request: existing };
      }

      // Keep it marked as our own if this device created it.
      const stored = {
        ...incoming,
        source: existing?.source === "local" ? "local" : "remote",
        receivedFrom: existing?.receivedFrom || meta.fromLabel || "another device",
        receivedAt: existing?.receivedAt || new Date().toISOString(),
      };

      await saveRequest(stored);
      applyRequests((previous) => upsertRequest(previous, stored));

      setTransferStatus(
        decision === "new"
          ? `Received emergency ${stored.id} from ${stored.receivedFrom}. Saved on this device.`
          : `Updated emergency ${stored.id} from ${meta.fromLabel || "another device"}.`
      );
      return { ok: true, status: decision, request: stored };
    } catch (error) {
      console.error("Failed to save incoming emergency:", error);
      setTransferStatus("Error saving an incoming emergency request.");
      return { ok: false, error: "Could not save on the receiving device." };
    } finally {
      inFlightRef.current.delete(incoming.id);
    }
  }, [applyRequests]);

  // ---------------- VOLUNTEERS ----------------

  const handleIncomingVolunteer = useCallback(async (raw, meta = {}) => {
    const checked = validateVolunteer(raw);
    if (!checked.ok) {
      console.warn("Rejected incoming volunteer:", checked.error);
      return { ok: false, error: checked.error };
    }
    const incoming = checked.volunteer;

    if (inFlightVolunteersRef.current.has(incoming.id)) {
      return { ok: true, status: "duplicate", volunteer: incoming };
    }
    inFlightVolunteersRef.current.add(incoming.id);

    try {
      const existing = await getVolunteer(incoming.id);
      const decision = decideMerge(existing, incoming);
      if (decision === "duplicate") return { ok: true, status: "duplicate", volunteer: existing };

      await saveVolunteer(incoming);
      applyVolunteers((previous) => upsertVolunteer(previous, incoming));
      setTransferStatus(
        decision === "new"
          ? `Volunteer ${incoming.name} registered (from ${meta.fromLabel || "another device"}).`
          : `Volunteer ${incoming.name} updated.`
      );
      return { ok: true, status: decision, volunteer: incoming };
    } catch (error) {
      console.error("Failed to save incoming volunteer:", error);
      return { ok: false, error: "Could not save on the receiving device." };
    } finally {
      inFlightVolunteersRef.current.delete(incoming.id);
    }
  }, [applyVolunteers]);

  // One profile per device. Returns false if it could not be saved.
  async function handleSaveVolunteer(profile) {
    const id = volunteerIdForDevice(device.id);
    const existing = volunteersRef.current.find((item) => item.id === id);
    const nowMs = Date.now();
    const previousStamp = existing ? Date.parse(existing.updatedAt) : 0;
    const volunteer = {
      id,
      name: profile.name,
      skills: profile.skills,
      area: profile.area || "",
      available: profile.available !== false,
      ...(Number.isInteger(profile.capacity) ? { capacity: profile.capacity } : {}),
      createdAt: existing?.createdAt || new Date(nowMs).toISOString(),
      updatedAt: new Date(Math.max(nowMs, previousStamp + 1)).toISOString(),
    };

    const checked = validateVolunteer(volunteer);
    if (!checked.ok) {
      setTransferStatus(checked.error);
      return false;
    }

    try {
      await saveVolunteer(checked.volunteer);
    } catch (error) {
      console.error("Failed to save volunteer:", error);
      setTransferStatus("Could not save the volunteer profile on this device.");
      return false;
    }

    applyVolunteers((previous) => upsertVolunteer(previous, checked.volunteer));
    const sent = volunteerSenderRef.current ? volunteerSenderRef.current(checked.volunteer) : false;
    setTransferStatus(
      sent
        ? `Volunteer profile saved and shared with connected devices.`
        : `Volunteer profile saved on this device. It will be shared when you pair a device.`
    );
    return true;
  }

  // Assigning is a normal request update, so it saves locally, syncs to peers
  // and is only "delivered" after an ACK.
  async function handleAssign(request, volunteer) {
    // Re-check with the latest data: another device may have assigned this volunteer meanwhile.
    if (!fitsCapacity(volunteer, request, requestsRef.current)) {
      const room = remainingCapacity(volunteer, requestsRef.current);
      setTransferStatus(
        `${volunteer.name} can only take ${Math.max(room, 0)} more ${room === 1 ? "person" : "people"}; ${request.id} needs ${request.people}.`
      );
      return;
    }
    const changed = withAssignment(request, volunteer);
    if (changed === request) return;
    await persistAndSend(changed, `assigned to ${volunteer.name}`);
  }

  // ---------------- OFFLINE SYNC (QR / file / pasted code) ----------------
  // The sync code is only a carrier. Every item goes through the same
  // validation and merge rules as items arriving over a live link.

  const handleSyncImport = useCallback(async (data) => {
    const tally = { created: 0, updated: 0, duplicate: 0, rejected: 0, volunteers: 0, volunteerDuplicates: 0 };
    const meta = { fromLabel: data.deviceName || "another device" };

    for (const raw of data.requests) {
      const result = await handleIncomingRequest(raw, meta);
      if (!result.ok) tally.rejected += 1;
      else if (result.status === "new") tally.created += 1;
      else if (result.status === "update") tally.updated += 1;
      else tally.duplicate += 1;
      // Pass new information on to any devices this one is linked to right now.
      if (result.ok && result.status !== "duplicate") networkSenderRef.current?.(result.request);
    }

    for (const raw of data.volunteers) {
      const result = await handleIncomingVolunteer(raw, meta);
      if (!result.ok) tally.rejected += 1;
      else if (result.status === "duplicate") tally.volunteerDuplicates += 1;
      else {
        tally.volunteers += 1;
        volunteerSenderRef.current?.(result.volunteer);
      }
    }

    setTransferStatus(
      `Offline sync from ${meta.fromLabel}: ${tally.created} new, ${tally.updated} updated, ${tally.duplicate} already had, ${tally.rejected} rejected.`
    );
    return tally;
  }, [handleIncomingRequest, handleIncomingVolunteer]);

  // ---------------- SEND EMERGENCY ----------------

  // Saves a new or changed request locally FIRST, then tries to send it.
  // Returns false if it could not even be saved on this device.
  async function persistAndSend(request, verb) {
    try {
      await saveRequest(request);
    } catch (error) {
      console.error("Failed to save emergency:", error);
      setTransferStatus("Could not save the emergency request on this device.");
      return false;
    }

    // Dashboard and map both read from this list.
    applyRequests((previous) => upsertRequest(previous, request));

    const sender = networkSenderRef.current;
    const sent = sender ? sender(request) : false;

    // "Sent" is NOT "delivered" until an ACK comes back.
    setDelivery((previous) => ({
      ...previous,
      [request.id]: { state: sent ? "pending" : "local", ackedBy: [] },
    }));
    setTransferStatus(
      sent
        ? `Emergency ${request.id} ${verb} and sent. Waiting for the other device to confirm…`
        : `Emergency ${request.id} ${verb} on this device only. No device is connected; it will be shared when you pair.`
    );
    return true;
  }

  async function handleNewRequest(newRequest) {
    if (savingIdsRef.current.has(newRequest.id)) return; // double-click guard
    savingIdsRef.current.add(newRequest.id);
    const saved = await persistAndSend({ ...newRequest, originName: device.name }, "saved");
    if (saved) setFormOpen(false);
    else savingIdsRef.current.delete(newRequest.id); // allow a retry
    return saved;
  }

  // Any paired device can update a request: there are no accounts in this
  // prototype. The newest change wins when devices merge.
  async function handleStatusChange(request, status) {
    const changed = withStatus(request, status);
    if (changed === request) return;
    await persistAndSend(changed, `marked ${status.toLowerCase()}`);
  }

  const handleAck = useCallback((id, peer) => {
    setDelivery((previous) => {
      const current = previous[id] || { state: "pending", ackedBy: [] };
      if (current.ackedBy.includes(peer.label)) return previous;
      return {
        ...previous,
        [id]: { state: "delivered", ackedBy: [...current.ackedBy, peer.label] },
      };
    });
    setTransferStatus(`${peer.label} confirmed it saved ${id}.`);
  }, []);

  // ---------------- NETWORK STATUS ----------------

  const handleSenderRegistration = useCallback((sender) => {
    networkSenderRef.current = sender;
  }, []);

  const handleNetworkStatus = useCallback((status) => {
    setNetwork(status);
  }, []);

  const handleVolunteerSenderRegistration = useCallback((sender) => {
    volunteerSenderRef.current = sender;
  }, []);

  const getSyncVolunteers = useCallback(
    () => volunteersRef.current.slice(0, MAX_SYNC_VOLUNTEERS),
    []
  );

  const getSyncRequests = useCallback(
    () => requestsRef.current.filter(isShareable).slice(0, MAX_SYNC_REQUESTS),
    []
  );

  const handleDeviceNameChange = useCallback((name) => {
    setDevice((previous) => {
      const next = { ...previous, name: name.slice(0, 40) };
      try {
        localStorage.setItem("lifeline-device", JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  function scrollTo(name) {
    const target = name === "top" ? document.body : sectionRefs.current[name];
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const networkOnline = network.openCount > 0;
  const count = (status) => requests.filter((request) => request.status === status).length;
  const openRequests = count("Open");
  const myVolunteer = volunteers.find((item) => item.id === volunteerIdForDevice(device.id)) || null;

  function deliveryText(request) {
    if (request.source === "remote") return `From ${request.receivedFrom || "another device"}`;
    if (request.source === "demo" || !request.createdAt) return "";
    const info = delivery[request.id];
    if (info?.state === "delivered") return `Delivered to ${info.ackedBy.join(", ")}`;
    if (info?.state === "pending") return "Sent – awaiting confirmation";
    return "Saved on this device";
  }

  // ---------------- RENDER ----------------

  return (
    <div className="app">

      <header className="masthead">
        <div className="masthead-inner">
          <div className="wordmark">
            <Heart size={20} fill="currentColor" />
            <strong>LIFELINE</strong>
          </div>

          <nav className="main-nav" aria-label="Sections">
            <button type="button" onClick={() => scrollTo("requests")}>
              Requests <span className="nav-count">{openRequests}</span>
            </button>
            <button type="button" onClick={() => scrollTo("map")}>Map</button>
            <button type="button" onClick={() => scrollTo("volunteers")}>Volunteers</button>
            <button type="button" onClick={() => scrollTo("network")}>Device links</button>
            <button type="button" onClick={() => scrollTo("offline")}>Offline sync</button>
          </nav>

          <span
            data-testid="network-pill"
            className={`link-status ${networkOnline ? "on" : "off"}`}
          >
            {networkOnline ? <Wifi size={15} /> : <WifiOff size={15} />}
            {networkOnline
              ? `Connected to ${network.openCount} device${network.openCount === 1 ? "" : "s"}`
              : "Not connected – saving locally"}
          </span>
        </div>
      </header>

      <main className="page">

        <div className="page-head">
          <div>
            <h1>Community desk</h1>
            <p>
              Requests are kept on this device ({device.name}) and passed directly
              between paired devices. Everything works without a server.
            </p>
          </div>
          <button className="btn primary" onClick={() => setFormOpen(true)}>
            <Plus size={16} /> New request
          </button>
        </div>

        {transferStatus && (
          <p role="status" data-testid="transfer-status" className="notice">
            {transferStatus}
          </p>
        )}

        <dl className="summary">
          <div><dt>Open</dt><dd>{openRequests}</dd></div>
          <div><dt>Assigned</dt><dd>{count("Assigned")}</dd></div>
          <div><dt>Resolved</dt><dd>{count("Resolved")}</dd></div>
          <div><dt>Volunteers available</dt><dd>{volunteers.filter((v) => v.available).length}</dd></div>
          <div><dt>Linked devices</dt><dd>{network.openCount}</dd></div>
        </dl>

        <div className="workspace">

          <section className="block" ref={(el) => { sectionRefs.current.requests = el; }}>
            <div className="block-head">
              <h2>Emergency requests</h2>
              <span>{requests.length} on this device</span>
            </div>

            <div className="request-list" data-testid="request-list">

              {requests.length === 0 && (
                <p className="empty-state">No emergency requests yet. Use “New request” to create one.</p>
              )}

              {requests.map((request) => (
                <article
                  className={`request-row u-${String(request.urgency || "").toLowerCase()}`}
                  key={request.id}
                  data-testid="request-row"
                  data-id={request.id}
                >
                  <div className="request-main">
                    <div className="request-title">
                      <strong>{request.name}</strong>
                      <span className="urgency">{request.urgency}</span>
                    </div>
                    <p>
                      {request.category} · {request.location}
                      {request.people > 1 ? ` · ${request.people} people` : ""}
                    </p>
                    <small className="request-trace">
                      <code>{request.id}</code> · {formatRelativeTime(request, now)}
                      {request.source === "demo" && " · sample data"}
                    </small>
                    {request.assignedTo && request.status !== "Open" && (
                      <small className="request-assigned" data-testid="assigned-to">
                        Assigned to {request.assignedTo}
                      </small>
                    )}
                    <RequestMatches request={request} volunteers={volunteers} requests={requests} onAssign={handleAssign} />
                    {deliveryText(request) && (
                      <small className="request-delivery" data-testid="delivery">{deliveryText(request)}</small>
                    )}
                  </div>

                  <select
                    className="status-select"
                    aria-label={`Status of ${request.id}`}
                    data-testid="status-select"
                    value={request.status}
                    onChange={(event) => handleStatusChange(request, event.target.value)}
                  >
                    {STATUSES.map((status) => (
                      <option key={status}>{status}</option>
                    ))}
                  </select>
                </article>
              ))}

            </div>
          </section>

          <section className="block map-block" ref={(el) => { sectionRefs.current.map = el; }}>
            <div className="block-head">
              <h2>Map</h2>
              <span><MapPin size={13} /> {requests.filter((r) => Number.isFinite(r.lat)).length} located</span>
            </div>
            <EmergencyMap requests={requests} />
          </section>

        </div>

        <div ref={(el) => { sectionRefs.current.volunteers = el; }}>
          <VolunteerPanel
            me={myVolunteer}
            volunteers={volunteers}
            requests={requests}
            deviceName={device.name}
            onSave={handleSaveVolunteer}
            onAssign={handleAssign}
          />
        </div>

        <div ref={(el) => { sectionRefs.current.network = el; }}>
          <NetworkPanel
            device={device}
            onDeviceNameChange={handleDeviceNameChange}
            onMessage={handleIncomingRequest}
            onRegisterSender={handleSenderRegistration}
            onVolunteer={handleIncomingVolunteer}
            onRegisterVolunteerSender={handleVolunteerSenderRegistration}
            getSyncVolunteers={getSyncVolunteers}
            onAck={handleAck}
            onStatusChange={handleNetworkStatus}
            getSyncRequests={getSyncRequests}
          />
        </div>

        <div ref={(el) => { sectionRefs.current.offline = el; }}>
          <OfflineSync
            deviceName={device.name}
            getSyncRequests={getSyncRequests}
            getSyncVolunteers={getSyncVolunteers}
            onImport={handleSyncImport}
          />
        </div>

        <footer className="footer">
          Prototype. LIFELINE does not contact emergency services. In an emergency call 999.
        </footer>

      </main>

      {formOpen && (
        <RequestForm
          onClose={() => setFormOpen(false)}
          onSubmit={handleNewRequest}
        />
      )}

    </div>
  );
}

export default App;

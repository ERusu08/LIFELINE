import { useState } from "react";
import { HandHelping } from "lucide-react";
import {
  VOLUNTEER_SKILLS,
  fitsCapacity,
  matchVolunteers,
  remainingCapacity,
  suggestRequests,
  uncoveredRequests,
  volunteerLoad,
} from "../utils/requestSync";

function capacityText(volunteer, requests) {
  const load = volunteerLoad(volunteer, requests);
  if (!Number.isInteger(volunteer.capacity)) return load ? `Helping ${load} · no limit set` : "No limit set";
  const text = `Helping ${load} of ${volunteer.capacity}`;
  return load > volunteer.capacity ? `${text} (over capacity)` : text;
}

/** Volunteers who can take an open request, with an Assign button for each. */
export function RequestMatches({ request, volunteers, requests, onAssign }) {
  if (request.status !== "Open") return null;
  const matches = matchVolunteers(request, volunteers, requests);

  return (
    <details className="matches" data-testid="matches">
      <summary>
        {matches.length > 0
          ? `${matches.length} volunteer${matches.length === 1 ? "" : "s"} can help`
          : "No available volunteer matches yet"}
      </summary>
      {matches.length > 0 && (
        <ul>
          {matches.map((volunteer) => {
            const fits = fitsCapacity(volunteer, request, requests);
            const room = remainingCapacity(volunteer, requests);
            return (
              <li key={volunteer.id}>
                <span>
                  <strong>{volunteer.name}</strong>
                  <small>
                    {volunteer.skills.join(", ")}
                    {volunteer.area ? ` · ${volunteer.area}` : ""}
                  </small>
                  <small data-testid="capacity-note">
                    {fits
                      ? Number.isFinite(room) ? `Room for ${room} more` : "No limit set"
                      : `Needs room for ${request.people}, has ${room}`}
                  </small>
                </span>
                <button
                  type="button"
                  className="btn small"
                  data-testid="assign-button"
                  disabled={!fits}
                  title={fits ? undefined : "This would put the volunteer over their limit"}
                  onClick={() => onAssign(request, volunteer)}
                >
                  Assign
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}

function ProfileForm({ me, deviceName, onSave }) {
  const [name, setName] = useState(me?.name || deviceName || "");
  const [skills, setSkills] = useState(me?.skills || []);
  const [area, setArea] = useState(me?.area || "");
  const [available, setAvailable] = useState(me ? me.available : true);
  const [capacity, setCapacity] = useState(String(me?.capacity ?? 10));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function toggleSkill(skill) {
    setSkills((current) =>
      current.includes(skill) ? current.filter((item) => item !== skill) : [...current, skill]
    );
  }

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    if (!name.trim()) return setError("Enter a name others will see.");
    if (skills.length === 0) return setError("Choose at least one kind of help you can offer.");
    const limit = Number(capacity);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      return setError("Enter how many people you can help at once (1 to 1000).");
    }
    setError("");
    setSaving(true);
    const ok = await onSave({ name: name.trim(), skills, area: area.trim(), available, capacity: limit });
    setSaving(false);
    if (ok === false) setError("Could not save the profile on this device.");
  }

  return (
    <form className="volunteer-form" onSubmit={submit}>
      <label>
        Volunteer name
        <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </label>

      <fieldset>
        <legend>Help you can offer</legend>
        <div className="skill-grid">
          {VOLUNTEER_SKILLS.map((skill) => (
            <label key={skill} className="check">
              <input type="checkbox" checked={skills.includes(skill)} onChange={() => toggleSkill(skill)} />
              {skill}
            </label>
          ))}
        </div>
      </fieldset>

      <label>
        Area you can cover
        <input value={area} maxLength={80} placeholder="e.g. Camden, within 2 km" onChange={(e) => setArea(e.target.value)} />
      </label>

      <label>
        People you can help at once
        <input type="number" min="1" max="1000" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
      </label>

      <label className="check">
        <input type="checkbox" checked={available} onChange={(e) => setAvailable(e.target.checked)} />
        Available now
      </label>

      {error && <p className="form-error" role="alert">{error}</p>}

      <button type="submit" className="btn primary" disabled={saving}>
        {me ? "Save profile" : "Register as volunteer"}
      </button>
    </form>
  );
}

export default function VolunteerPanel({ me, volunteers, requests, deviceName, onSave, onAssign }) {
  const [editing, setEditing] = useState(false);
  const available = volunteers.filter((volunteer) => volunteer.available);
  const mine = me ? suggestRequests(me, requests) : [];
  const uncovered = uncoveredRequests(requests, volunteers);
  const showForm = !me || editing;

  async function handleSave(profile) {
    const ok = await onSave(profile);
    if (ok !== false) setEditing(false);
    return ok;
  }

  return (
    <section className="block volunteers" data-testid="volunteer-panel">
      <div className="block-head">
        <h2>Volunteers</h2>
        <span>{available.length} available · {volunteers.length} registered</span>
      </div>

      <div className="volunteer-grid">
        <div>
          <h3>Your volunteer profile</h3>
          {showForm ? (
            <ProfileForm key={me?.updatedAt || "new"} me={me} deviceName={deviceName} onSave={handleSave} />
          ) : (
            <div className="my-profile" data-testid="my-profile">
              <p>
                <strong>{me.name}</strong>{" "}
                <span className={`pill ${me.available ? "on" : "off"}`}>
                  {me.available ? "Available" : "Not available"}
                </span>
              </p>
              <p className="hint">Offers: {me.skills.join(", ")}{me.area ? ` · ${me.area}` : ""}</p>
              <p className="hint" data-testid="my-capacity">{capacityText(me, requests)}</p>
              <div className="btn-row">
                <button type="button" className="btn" onClick={() => onSave({ ...me, available: !me.available })}>
                  {me.available ? "Mark not available" : "Mark available"}
                </button>
                <button type="button" className="btn ghost" onClick={() => setEditing(true)}>Edit profile</button>
              </div>
            </div>
          )}
        </div>

        <div>
          <h3>Requests you can help with</h3>
          {!me && <p className="hint">Register as a volunteer to see open requests that match what you offer.</p>}
          {me && !me.available && <p className="hint">You are marked not available.</p>}
          {me && me.available && mine.length === 0 && (
            <p className="hint">No open requests match your skills right now.</p>
          )}
          {me && me.available && mine.length > 0 && (
            <ul className="suggest-list">
              {mine.slice(0, 5).map((request) => (
                <li key={request.id} className={`u-${request.urgency.toLowerCase()}`}>
                  <span>
                    <strong>{request.name}</strong>
                    <small>
                      <span className="urgency">{request.urgency}</span> · {request.category} · {request.location}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="btn small"
                    data-testid="take-button"
                    disabled={!fitsCapacity(me, request, requests)}
                    title={fitsCapacity(me, request, requests) ? undefined : "This would put you over your limit"}
                    onClick={() => onAssign(request, me)}
                  >
                    <HandHelping size={14} /> Take this
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {uncovered.length > 0 && (
        <p className="notice warn" data-testid="uncovered">
          {uncovered.length} open request{uncovered.length === 1 ? " has" : "s have"} no available volunteer with the right skills.
        </p>
      )}

      <h3>All volunteers</h3>
      {volunteers.length === 0 ? (
        <p className="empty-state">No volunteers registered yet. Volunteers from paired devices appear here.</p>
      ) : (
        <ul className="volunteer-list" data-testid="volunteer-list">
          {volunteers.map((volunteer) => (
            <li key={volunteer.id} data-testid="volunteer-row">
              <span className={`dot ${volunteer.available ? "on" : "off"}`} />
              <strong>{volunteer.name}</strong>
              <span className="peer-state">
                {volunteer.skills.join(", ")}{volunteer.area ? ` · ${volunteer.area}` : ""}
              </span>
              <span className="hint" data-testid="volunteer-capacity">
                {capacityText(volunteer, requests)} · {volunteer.available ? "Available" : "Not available"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

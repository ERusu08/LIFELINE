
import { useEffect, useRef, useState } from "react";
import { X, Send, AlertTriangle, MapPin, LocateFixed, Sparkles } from "lucide-react";
import { CATEGORIES, URGENCIES, makeRequestId } from "../utils/requestSync";
import { suggestTriage, SOURCE_LABEL } from "../utils/triage";

export default function RequestForm({ onClose, onSubmit }) {
  const [form, setForm] = useState({
    name: "",
    category: "Medical assistance",
    location: "",
    people: 1,
    urgency: "High",
    description: "",
  });

  // One ID per form, so a double-click can never create two requests.
  const idRef = useRef(makeRequestId());
  const [submitting, setSubmitting] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const triageRunRef = useRef(0);
  const [formError, setFormError] = useState("");
  const [coordinates, setCoordinates] = useState(null);
  const [locationError, setLocationError] = useState("");
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    const onKey = (event) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function update(field, value) {
    setForm((previous) => ({
      ...previous,
      [field]: value,
    }));
  }

  async function runTriage() {
    const run = ++triageRunRef.current;
    setSuggesting(true);
    setSuggestion(null);
    const result = await suggestTriage(form.description);
    // Ignore the answer if the description changed while we were waiting.
    if (run !== triageRunRef.current) return;
    setSuggesting(false);
    setSuggestion(result);
  }

  function applySuggestion() {
    setForm((previous) => ({
      ...previous,
      category: suggestion.category,
      urgency: suggestion.urgency,
      people: suggestion.people || previous.people,
    }));
    setSuggestion(null);
  }

  function getLocation() {
    if (!navigator.geolocation) {
      setLocationError("Your browser does not support geolocation.");
      return;
    }

    setLocating(true);
    setLocationError("");

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCoordinates({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
        setLocating(false);
      },
      (error) => {
        setLocationError(
          error.code === 1
            ? "Location permission denied. Please allow location access."
            : "Could not retrieve your location. Please try again."
        );
        setLocating(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
      }
    );
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const name = form.name.trim();
    const location = form.location.trim();
    const description = form.description.trim();
    if (!name || !location || !description) {
      setFormError("Name, location and description cannot be empty.");
      return;
    }
    setFormError("");

    const createdAt = new Date().toISOString();
    const request = {
      ...form,
      name,
      location,
      description,
      // Without GPS the request still works, but cannot be placed on the map.
      ...(coordinates || {}),
      people: Math.max(1, Math.round(Number(form.people) || 1)),
      id: idRef.current,
      status: "Open",
      createdAt,
      updatedAt: createdAt,
      source: "local",
    };

    setSubmitting(true);
    const saved = await onSubmit(request);
    // On success the parent closes the form; on failure let the user retry.
    if (saved === false) setSubmitting(false);
  }

  return (
    <div className="modal-overlay">
      <form
        className="request-form"
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="request-form-title"
      >
        <div className="form-heading">
          <div>
            <h2 id="request-form-title">New emergency request</h2>
            <p>Submit a report for your local response network.</p>
          </div>

          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </div>

        <label>
          Household or reporter name
          <input
            required
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="e.g. Household A"
          />
        </label>

        <label>
          What assistance is needed?
          <select
            value={form.category}
            onChange={(e) => update("category", e.target.value)}
          >
            {CATEGORIES.map((category) => (
              <option key={category}>{category}</option>
            ))}
          </select>
        </label>

        <label>
          Location / neighbourhood
          <input
            required
            value={form.location}
            onChange={(e) => update("location", e.target.value)}
            placeholder="Enter neighbourhood or postcode"
          />
        </label>

        <div>
          <button
            type="button"
            className="btn"
            onClick={getLocation}
            disabled={locating}
          >
            <LocateFixed size={16} />
            {locating ? "Finding location..." : "Use my current location"}
          </button>

          {coordinates && (
            <p className="loc-note ok">
              <MapPin size={13} /> Location captured successfully
            </p>
          )}

          {!coordinates && !locationError && (
            <p className="loc-note">
              Optional, but without it this request will not appear on the map.
            </p>
          )}

          {locationError && (
            <p className="loc-note bad">
              {locationError}
            </p>
          )}
        </div>

        <label>
          Number of people affected
          <input
            required
            type="number"
            min="1"
            value={form.people}
            onChange={(e) => update("people", Number(e.target.value))}
          />
        </label>

        <label>
          Urgency
          <select
            value={form.urgency}
            onChange={(e) => update("urgency", e.target.value)}
          >
            {URGENCIES.map((urgency) => (
              <option key={urgency}>{urgency}</option>
            ))}
          </select>
        </label>

        <label>
          Describe the situation
          <textarea
            required
            rows="3"
            value={form.description}
            onChange={(e) => {
              update("description", e.target.value);
              triageRunRef.current += 1; // any pending suggestion is now stale
              setSuggestion(null);
              setSuggesting(false);
            }}
            placeholder="Explain what has happened and what is needed..."
          />
        </label>

        <div className="triage">
          <button
            type="button"
            className="btn"
            onClick={runTriage}
            disabled={suggesting || form.description.trim().length < 5}
          >
            <Sparkles size={16} /> {suggesting ? "Analysing…" : "Suggest category and urgency"}
          </button>

          {suggestion && (
            <div className="triage-result" role="status" data-testid="triage-result">
              <p>
                Suggested: <strong>{suggestion.category}</strong> ·{" "}
                <strong>{suggestion.urgency}</strong>
                {suggestion.people ? <> · <strong>{suggestion.people}</strong> {suggestion.people === 1 ? "person" : "people"}</> : null}
              </p>
              <small>From {SOURCE_LABEL[suggestion.source]}. Check it before applying.</small>
              <div className="btn-row">
                <button type="button" className="btn small" data-testid="triage-apply" onClick={applySuggestion}>Apply</button>
                <button type="button" className="btn small" onClick={() => setSuggestion(null)}>Dismiss</button>
              </div>
            </div>
          )}
        </div>

        {formError && <p className="form-error" role="alert">{formError}</p>}

        <div className="form-warning">
          <AlertTriangle size={16} />
          <span>This prototype does not contact emergency services. In a real emergency in the UK, call 999.</span>
        </div>

        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>

          <button type="submit" className="btn primary" disabled={submitting}>
            <Send size={16} /> {submitting ? "Saving…" : "Submit request"}
          </button>
        </div>
      </form>
    </div>
  );
}

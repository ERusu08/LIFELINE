
import { useState } from "react";
import { X, Send, AlertTriangle, MapPin, LocateFixed } from "lucide-react";

export default function RequestForm({ onClose, onSubmit }) {
  const [form, setForm] = useState({
    name: "",
    category: "Medical assistance",
    location: "",
    people: 1,
    urgency: "High",
    description: "",
  });

  const [coordinates, setCoordinates] = useState(null);
  const [locationError, setLocationError] = useState("");
  const [locating, setLocating] = useState(false);

  function update(field, value) {
    setForm((previous) => ({
      ...previous,
      [field]: value,
    }));
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

  function handleSubmit(event) {
    event.preventDefault();

    if (!coordinates) {
      setLocationError("Please capture your location before submitting.");
      return;
    }

    const request = {
      ...form,
      ...coordinates,
      id: `SOS-${Date.now()}`,
      status: "Open",
      time: "Just now",
      createdAt: new Date().toISOString(),
      source: "local",
    };

    onSubmit(request);
    onClose();
  }

  return (
    <div className="modal-overlay">
      <form className="request-form" onSubmit={handleSubmit}>
        <div className="form-heading">
          <div>
            <span className="eyebrow">COMMUNITY SUPPORT</span>
            <h2>New emergency request</h2>
            <p>Submit a report for your local response network.</p>
          </div>

          <button type="button" className="icon-button" onClick={onClose}>
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
            <option>Medical assistance</option>
            <option>Water supplies</option>
            <option>Food supplies</option>
            <option>Shelter</option>
            <option>Transport</option>
            <option>Other</option>
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
            className="network-button"
            onClick={getLocation}
            disabled={locating}
          >
            <LocateFixed size={16} />
            {locating ? "Finding location..." : "Use my current location"}
          </button>

          {coordinates && (
            <p style={{ color: "#22c55e", fontSize: "12px", marginTop: "8px" }}>
              <MapPin size={13} /> Location captured successfully
            </p>
          )}

          {locationError && (
            <p style={{ color: "#ef7777", fontSize: "12px", marginTop: "8px" }}>
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
            <option>Critical</option>
            <option>High</option>
            <option>Medium</option>
            <option>Low</option>
          </select>
        </label>

        <label>
          Describe the situation
          <textarea
            required
            rows="3"
            value={form.description}
            onChange={(e) => update("description", e.target.value)}
            placeholder="Explain what has happened and what is needed..."
          />
        </label>

        <div className="form-warning">
          <AlertTriangle size={16} />
          This prototype does not contact emergency services. In a real emergency in the UK, call 999.
        </div>

        <div className="form-actions">
          <button type="button" className="cancel-button" onClick={onClose}>
            Cancel
          </button>

          <button type="submit" className="submit-button">
            <Send size={16} /> Submit request
          </button>
        </div>
      </form>
    </div>
  );
}

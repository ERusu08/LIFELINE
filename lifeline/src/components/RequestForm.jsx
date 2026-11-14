
import { useState } from "react";
import { X, Send, AlertTriangle } from "lucide-react";

export default function RequestForm({ onClose, onSubmit }) {
  const [form, setForm] = useState({
    name: "",
    category: "Medical assistance",
    location: "",
    people: 1,
    urgency: "High",
    description: "",
  });

  function update(field, value) {
    setForm((previous) => ({
      ...previous,
      [field]: value,
    }));
  }

  function handleSubmit(event) {
    event.preventDefault();

    const request = {
      ...form,
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
          Location
          <input
            required
            value={form.location}
            onChange={(e) => update("location", e.target.value)}
            placeholder="Enter neighbourhood or postcode"
          />
        </label>

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

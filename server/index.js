const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const reports = [];

const agents = [
  { id: "agent-north", group: "North", connected: true },
  { id: "agent-central", group: "Central", connected: true },
  { id: "agent-south", group: "South", connected: true },
];

function extractPeopleCount(text) {
  const value = text.toLowerCase();

  const words = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };

  for (const [word, count] of Object.entries(words)) {
    if (value.includes(`${word} people`) || value.includes(`${word} person`)) {
      return count;
    }
  }

  for (let count = 1; count <= 100; count++) {
    if (value.includes(`${count} people`) || value.includes(`${count} person`)) {
      return count;
    }
  }

  return 1;
}

function classifyReport(description) {
  const text = description.toLowerCase();

  let type = "SOS";

  if (/medical|injury|medicine|first aid|bleeding/.test(text)) {
    type = "MEDICAL";
  } else if (/water|food|blanket|supplies/.test(text)) {
    type = "SUPPLIES";
  } else if (/offer|volunteer|can help|transport/.test(text)) {
    type = "OFFER_HELP";
  } else if (/safe|checked in|we are okay/.test(text)) {
    type = "SAFE";
  }

  const urgency = /trapped|can't breathe|unconscious|bleeding heavily/.test(text)
    ? "critical"
    : /injury|medical|medicine|first aid/.test(text)
      ? "high"
      : "medium";

  return { type, urgency };
}
function extractResources(description) {
  const keywords = [
    "water",
    "food",
    "medicine",
    "first aid",
    "transport",
    "blanket",
    "charging",
    "shelter",
  ];

  const text = description.toLowerCase();
  return keywords.filter((keyword) => text.includes(keyword));
}
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "LIFELINE backend" });
});

app.get("/api/reports", (_req, res) => {
  res.json(reports);
});

app.post("/api/reports", (req, res) => {
  const { description, location, agentId } = req.body;

  if (typeof description !== "string" || !description.trim()) {
    return res.status(400).json({ error: "description is required" });
  }

  const cleanDescription = description.trim();
  console.log("DEBUG count:", extractPeopleCount(cleanDescription));
  const { type, urgency } = classifyReport(cleanDescription);
  const now = new Date().toISOString();

  const report = {
    id: crypto.randomUUID(),
    type,
    description: cleanDescription,
    status: "open",
    urgency,
    peopleAffected: extractPeopleCount(cleanDescription),
    location: location ?? null,
    needs: type === "SUPPLIES" ? ["supplies"] : [],
    offeredResources: type === "OFFER_HELP" ? ["help"] : [],
    agentId: agentId ?? "agent-north",
    createdAt: now,
    updatedAt: now,
    duplicateOf: null,
  };

  reports.unshift(report);

  res.status(201).json(report);
});

app.get("/api/agents", (_req, res) => {
  res.json(agents);
});

app.post("/api/network/disconnect", (_req, res) => {
  agents.forEach((agent) => {
    agent.connected = false;
  });

  res.json({ connected: false, agents });
});

app.post("/api/network/reconnect", (_req, res) => {
  agents.forEach((agent) => {
    agent.connected = true;
  });

  res.json({ connected: true, agents, reconciled: true });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`LIFELINE API running on port ${PORT}`);
});
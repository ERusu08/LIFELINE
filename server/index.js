const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const { randomUUID } = require("crypto");

const app = express();

app.use(cors());
app.use(express.json());

const reports = [];
const events = [];
let networkConnected = true;

const agents = [
  { id: "agent-north", group: "North", connected: true },
  { id: "agent-central", group: "Central", connected: true },
  { id: "agent-south", group: "South", connected: true },
];

const agentReportIds = new Map(
  agents.map((agent) => [agent.id, new Set()]),
);

let geminiClient;

console.log("Gemini key loaded:", Boolean(process.env.GEMINI_API_KEY));

function addEvent(type, agentId, entityId, details = {}) {
  events.unshift({
    id: randomUUID(),
    type,
    agentId: agentId ?? null,
    entityId: entityId ?? null,
    createdAt: new Date().toISOString(),
    details,
  });
}

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

function classifyLocally(description) {
  const text = description.toLowerCase();

  let type = "SOS";

  if (/offer|volunteer|can help|i have|i can provide|available to help/.test(text)) {
    type = "OFFER_HELP";
  } else if (/medical|injury|medicine|first aid|bleeding/.test(text)) {
    type = "MEDICAL";
  } else if (/water|food|blanket|supplies|charging|shelter|transport/.test(text)) {
    type = "SUPPLIES";
  } else if (/safe|checked in|we are okay/.test(text)) {
    type = "SAFE";
  }

  const urgency =
    /trapped|can't breathe|unconscious|bleeding heavily/.test(text)
      ? "critical"
      : /injury|medical|medicine|first aid/.test(text)
        ? "high"
        : "medium";

  return { type, urgency };
}
function withTimeout(promise, milliseconds) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Gemini request timed out")),
      milliseconds,
    );
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
async function classifyWithGemini(description) {
  const fallback = classifyLocally(description);

  if (!process.env.GEMINI_API_KEY) {
    return { ...fallback, source: "rules" };
  }

  try {
    if (!geminiClient) {
      const { GoogleGenAI } = await import("@google/genai");
      geminiClient = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
      });
    }

    const result = await withTimeout(geminiClient.interactions.create({
      model: "gemini-3.8-flash",
      input: `Classify this emergency report. Do not give advice.
Report: ${description}`,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["SOS", "MEDICAL", "SUPPLIES", "OFFER_HELP", "SAFE"],
            },
            urgency: {
              type: "string",
              enum: ["critical", "high", "medium", "low"],
            },
          },
          required: ["type", "urgency"],
        },
      },
   }), 15000);

    if (!result.output_text) {
      throw new Error("Gemini returned an empty response");
    }

    const parsed = JSON.parse(result.output_text);
    const validTypes = ["SOS", "MEDICAL", "SUPPLIES", "OFFER_HELP", "SAFE"];
    const validUrgencies = ["critical", "high", "medium", "low"];

    return {
      type: validTypes.includes(parsed.type) ? parsed.type : fallback.type,
      urgency: validUrgencies.includes(parsed.urgency)
        ? parsed.urgency
        : fallback.urgency,
      source: "gemini",
    };
  } catch (error) {
    console.error("Gemini unavailable; using local rules:", error.message);
    return { ...fallback, source: "rules" };
  }
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

function getVisibleReports(agentId) {
  if (!agentId) return reports;

  const knownIds = agentReportIds.get(agentId);
  if (!knownIds) return null;

  if (networkConnected) return reports;

  return reports.filter((report) => knownIds.has(report.id));
}

function markPossibleDuplicates() {
  const oldestFirst = [...reports].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  );

  for (let i = 0; i < oldestFirst.length; i++) {
    const first = oldestFirst[i];

    if (first.type === "OFFER_HELP" || first.type === "SAFE") continue;

    for (let j = i + 1; j < oldestFirst.length; j++) {
      const second = oldestFirst[j];

      if (second.type !== first.type) continue;
      if (second.type === "OFFER_HELP" || second.type === "SAFE") continue;

      const minutesApart =
        Math.abs(new Date(second.createdAt) - new Date(first.createdAt)) / 60000;

      if (minutesApart > 15) continue;

      const firstLocation = first.location?.label?.trim().toLowerCase();
      const secondLocation = second.location?.label?.trim().toLowerCase();
      const sameLocation =
        firstLocation && secondLocation && firstLocation === secondLocation;

      const sameNeed = first.needs.some((need) => second.needs.includes(need));

      const sameDescription =
        first.description.trim().toLowerCase() ===
        second.description.trim().toLowerCase();

      if ((sameLocation && sameNeed) || sameDescription) {
        if (!second.duplicateOf) {
          second.duplicateOf = first.id;
          addEvent("POSSIBLE_DUPLICATE", second.agentId, second.id, {
            duplicateOf: first.id,
          });
        }
      }
    }
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "LIFELINE backend" });
});

app.get("/api/reports", (req, res) => {
  const visibleReports = getVisibleReports(req.query.agentId);

  if (visibleReports === null) {
    return res.status(404).json({ error: "agent not found" });
  }

  res.json(visibleReports);
});

app.post("/api/reports", async (req, res) => {
  const { description, location, agentId } = req.body;

  if (typeof description !== "string" || !description.trim()) {
    return res.status(400).json({ error: "description is required" });
  }

  const submittingAgentId = agentId ?? "agent-north";
  const submittingAgent = agents.find(
    (agent) => agent.id === submittingAgentId,
  );

  if (!submittingAgent) {
    return res.status(400).json({ error: "unknown agentId" });
  }

  const cleanDescription = description.trim();
  const classification = await classifyWithGemini(cleanDescription);
  const { type, urgency } = classification;
  const resources = extractResources(cleanDescription);
  const now = new Date().toISOString();

  const report = {
    id: randomUUID(),
    type,
    description: cleanDescription,
    status: "open",
    urgency,
    classificationSource: classification.source,
    peopleAffected: extractPeopleCount(cleanDescription),
    location: location ?? null,
    needs: type === "OFFER_HELP" || type === "SAFE" ? [] : resources,
    offeredResources: type === "OFFER_HELP" ? resources : [],
    agentId: submittingAgentId,
    createdAt: now,
    updatedAt: now,
    duplicateOf: null,
  };

  reports.unshift(report);
  agentReportIds.get(submittingAgentId).add(report.id);

  if (networkConnected) {
    for (const knownIds of agentReportIds.values()) {
      knownIds.add(report.id);
    }
  }

  addEvent("REPORT_CREATED", submittingAgentId, report.id, { type });

  res.status(201).json(report);
});

app.get("/api/matches", (req, res) => {
  const visibleReports = getVisibleReports(req.query.agentId);

  if (visibleReports === null) {
    return res.status(404).json({ error: "agent not found" });
  }

  const requests = visibleReports.filter(
    (report) =>
      report.type !== "OFFER_HELP" &&
      report.type !== "SAFE" &&
      report.status === "open",
  );

  const offers = visibleReports.filter(
    (report) => report.type === "OFFER_HELP" && report.status === "open",
  );

  const usedOffers = new Set();
  const matches = [];

  for (const request of requests) {
    for (const offer of offers) {
      if (usedOffers.has(offer.id)) continue;

      const resource = request.needs.find((need) =>
        offer.offeredResources.includes(need),
      );

      if (resource) {
        matches.push({
          requestId: request.id,
          offerId: offer.id,
          resource,
          status: "suggested",
        });
        usedOffers.add(offer.id);
        break;
      }
    }
  }

  res.json(matches);
});

app.get("/api/agents", (_req, res) => {
  res.json(agents);
});

app.get("/api/events", (_req, res) => {
  res.json(events);
});

app.post("/api/network/disconnect", (_req, res) => {
  networkConnected = false;

  agents.forEach((agent) => {
    agent.connected = false;
  });

  addEvent("NETWORK_DISCONNECTED", null, null, {
    groups: agents.map((agent) => agent.group),
  });

  res.json({
    connected: false,
    message: "Agents are now working with their local reports.",
    agents,
  });
});

app.post("/api/network/reconnect", (_req, res) => {
  const allKnownIds = new Set();

  for (const knownIds of agentReportIds.values()) {
    for (const reportId of knownIds) {
      allKnownIds.add(reportId);
    }
  }

  let newlyShared = 0;

  for (const knownIds of agentReportIds.values()) {
    for (const reportId of allKnownIds) {
      if (!knownIds.has(reportId)) newlyShared++;
      knownIds.add(reportId);
    }
  }

  networkConnected = true;

  agents.forEach((agent) => {
    agent.connected = true;
  });

  markPossibleDuplicates();

  addEvent("NETWORK_RECONNECTED", null, null, {
    reportsShared: allKnownIds.size,
    newCopiesShared: newlyShared,
  });

  res.json({
    connected: true,
    reconciled: true,
    reportsShared: allKnownIds.size,
    newCopiesShared: newlyShared,
    agents,
  });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`LIFELINE API running on port ${PORT}`);
});
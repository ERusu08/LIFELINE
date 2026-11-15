// Suggests a category, urgency and head-count for a new emergency request.
//
// Order of preference:
//   1. POST /api/triage on the LIFELINE server (Gemini AI if the server has a
//      key, otherwise the server's keyword rules)
//   2. Rules on this device, so triage still works offline.
// The result always says which one produced it. Suggestions are never
// applied automatically.

import { CATEGORIES } from "./requestSync.js";

const CATEGORY_KEYWORDS = [
  ["Medical assistance", /medical|injur|medicine|insulin|first aid|bleed|wound|broken|fractur|breath|unconscious|asthma|diabet|pregnan|heart|pain|ambulance|dialysis|oxygen/],
  ["Water supplies", /water|thirst|dehydrat|drink/],
  ["Food supplies", /food|hungry|hunger|meal|formula|eat\b|groceries/],
  ["Transport", /transport|lift|ride|car\b|evacuat|stranded|wheelchair|can'?t (get|travel)|bus\b/],
  ["Shelter", /shelter|blanket|cold|roof|homeless|flood(ed|ing)?\b|house (is )?(damaged|destroyed)|evacuat(ed|ion) centre|nowhere to (stay|sleep)|power|heating/],
];

const CRITICAL = /trapped|can'?t breathe|cannot breathe|not breathing|unconscious|bleeding (heavily|badly)|collapsed|fire\b|drowning|heart attack|stroke|overdose|unresponsive/;
const HIGH = /injur|medical|medicine|insulin|first aid|bleed|elderly|child|children|baby|infant|pregnan|diabet|oxygen|dialysis|disabled|wheelchair|alone|no water|no food/;
const LOW = /not urgent|no rush|whenever|low priority|when possible|just checking|spare/;

const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

export function categoryFromText(text) {
  const value = String(text || "").toLowerCase();
  for (const [category, pattern] of CATEGORY_KEYWORDS) {
    if (pattern.test(value)) return category;
  }
  return "Other";
}

export function urgencyFromText(text) {
  const value = String(text || "").toLowerCase();
  if (CRITICAL.test(value)) return "Critical";
  if (HIGH.test(value)) return "High";
  if (LOW.test(value)) return "Low";
  return "Medium";
}

export function peopleFromText(text) {
  const value = String(text || "").toLowerCase();
  const unit = "(?:people|persons?|adults?|children|kids|residents|of us|individuals)";
  const digits = new RegExp(`\\b(\\d{1,4})\\s+${unit}`).exec(value);
  if (digits) return Math.min(Math.max(Number(digits[1]), 1), 10000);
  const words = new RegExp(`\\b(${Object.keys(WORD_NUMBERS).join("|")})\\s+${unit}`).exec(value);
  if (words) return WORD_NUMBERS[words[1]];
  const family = /family of (\d{1,3})/.exec(value);
  if (family) return Math.max(Number(family[1]), 1);
  return null;
}

/** Rule-based triage that needs no network. */
export function triageLocally(description) {
  return {
    category: categoryFromText(description),
    urgency: urgencyFromText(description),
    people: peopleFromText(description),
    source: "device",
  };
}

const SERVER_URGENCY = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

/** Converts the server's reply into this app's fields; null if it is unusable. */
export function fromServerTriage(data, description) {
  if (!data || typeof data !== "object") return null;
  const urgency = SERVER_URGENCY[String(data.urgency || "").toLowerCase()];
  if (!urgency) return null;

  let category = categoryFromText(description);
  if (data.type === "MEDICAL") category = "Medical assistance";
  if (!CATEGORIES.includes(category)) category = "Other";

  const people = Number.isInteger(data.peopleAffected) && data.peopleAffected > 1
    ? Math.min(data.peopleAffected, 10000)
    : peopleFromText(description);

  return {
    category,
    urgency,
    people,
    source: data.source === "gemini" ? "gemini" : "server",
  };
}

export const SOURCE_LABEL = {
  gemini: "Gemini AI",
  server: "LIFELINE server rules",
  device: "on-device rules (offline)",
};

/**
 * Asks the server first, falls back to on-device rules.
 * Never throws; the description is only sent to the LIFELINE server.
 */
export async function suggestTriage(description, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const text = String(description || "").trim();
  if (!text) return null;

  if (typeof fetchImpl === "function") {
    try {
      const response = await fetchImpl("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: text.slice(0, 2000) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        const mapped = fromServerTriage(await response.json(), text);
        if (mapped) return mapped;
      }
    } catch {
      // Server not running or unreachable: use the offline rules below.
    }
  }
  return triageLocally(text);
}

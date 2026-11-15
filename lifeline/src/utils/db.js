// IndexedDB access for emergency requests and volunteers.
// Database "lifeline-db": v1 had "requests"; v2 adds "volunteers".
// Upgrading keeps every stored request.
import { openDB } from "idb";

const dbPromise = openDB("lifeline-db", 2, {
  upgrade(db) {
    if (!db.objectStoreNames.contains("requests")) {
      db.createObjectStore("requests", { keyPath: "id" });
    }
    if (!db.objectStoreNames.contains("volunteers")) {
      db.createObjectStore("volunteers", { keyPath: "id" });
    }
  },
});

export async function saveRequest(request) {
  const db = await dbPromise;
  await db.put("requests", request);
}

export async function getRequest(id) {
  const db = await dbPromise;
  return db.get("requests", id);
}

export async function getSavedRequests() {
  const db = await dbPromise;
  return db.getAll("requests");
}

export async function saveVolunteer(volunteer) {
  const db = await dbPromise;
  await db.put("volunteers", volunteer);
}

export async function getVolunteer(id) {
  const db = await dbPromise;
  return db.get("volunteers", id);
}

export async function getSavedVolunteers() {
  const db = await dbPromise;
  return db.getAll("volunteers");
}

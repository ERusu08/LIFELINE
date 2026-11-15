// IndexedDB access for emergency requests.
// Schema is unchanged: database "lifeline-db" v1, store "requests", keyPath "id".
import { openDB } from "idb";

const dbPromise = openDB("lifeline-db", 1, {
  upgrade(db) {
    if (!db.objectStoreNames.contains("requests")) {
      db.createObjectStore("requests", { keyPath: "id" });
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

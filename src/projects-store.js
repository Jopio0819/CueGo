// projects-store.js — recente projecten bewaren, op twee plekken:
//
// - Lokaal draaien (server.mjs) → als echte bestanden in de map projects/.
//   Zo staan je shows gewoon op schijf en kun je ze kopiëren/backuppen.
// - Statisch gehost (GitHub Pages) → in IndexedDB van de browser, want daar is
//   geen server om iets naartoe te schrijven.
//
// Beide leveren dezelfde API, zodat app.js het verschil niet hoeft te kennen.

const DB_NAME = 'webqlab-projects'; // eigen database; raakt de audio-opslag niet
const STORE = 'projects';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        let result;
        Promise.resolve(fn(t.objectStore(STORE))).then((r) => (result = r));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

// --- In de browser (statisch gehost) ---------------------------------------

const browserStore = {
  kind: 'browser',
  async list() {
    const rows = await tx('readonly', (store) => new Promise((resolve) => {
      const r = store.getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => resolve([]);
    }));
    return rows
      .map((r) => ({ name: r.name, size: r.blob?.size ?? 0, savedAt: r.savedAt }))
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  },
  async save(name, blob, savedAt) {
    await tx('readwrite', (store) => store.put({ name, blob, savedAt }));
  },
  async load(name) {
    const rec = await tx('readonly', (store) => new Promise((resolve) => {
      const r = store.get(name);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    }));
    return rec ? rec.blob : null;
  },
  async remove(name) {
    await tx('readwrite', (store) => store.delete(name));
  },
};

// --- Op de eigen server (bestanden in projects/) ----------------------------

const serverStore = {
  kind: 'server',
  async list() {
    const res = await fetch('api/projects', { cache: 'no-store' });
    if (!res.ok) throw new Error('Kon projecten niet ophalen');
    return await res.json();
  },
  async save(name, blob) {
    const res = await fetch(`api/projects/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Opslaan mislukt');
  },
  async load(name) {
    const res = await fetch(`api/projects/${encodeURIComponent(name)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.blob();
  },
  async remove(name) {
    await fetch(`api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
  },
};

export function createProjectStore(hasServer) {
  return hasServer ? serverStore : browserStore;
}

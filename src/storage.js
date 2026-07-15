// storage.js — bewaart de cue-lijst zodat een refresh de data teruglaadt.
// Audio-bytes gaan in IndexedDB (kan groot zijn); lichte metadata (naam, fades,
// volume, volgorde) in localStorage. Zo hoef je na een refresh niets opnieuw te slepen.

const DB_NAME = 'webqlab';
const STORE = 'audio';
const META_KEY = 'webqlab.cues.v1';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        Promise.resolve(fn(store)).then((r) => (result = r));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

// Bewaar de ruwe bytes van één cue, gekoppeld aan het cue-id.
export function saveAudio(id, file) {
  return tx('readwrite', (store) => store.put({ blob: file, name: file.name, type: file.type }, id));
}

// Herbouw een File uit de opgeslagen bytes (of null als niet gevonden).
export function loadAudio(id) {
  return tx('readonly', (store) => {
    return new Promise((resolve) => {
      const r = store.get(id);
      r.onsuccess = () => {
        const rec = r.result;
        resolve(rec ? new File([rec.blob], rec.name, { type: rec.type }) : null);
      };
      r.onerror = () => resolve(null);
    });
  });
}

export function deleteAudio(id) {
  return tx('readwrite', (store) => store.delete(id));
}

// Lichte metadata (volgorde inbegrepen) — synchroon via localStorage.
export function saveMeta(cues) {
  const meta = cues.map((c) => ({
    id: c.id,
    number: c.number || '',
    name: c.name,
    fadeIn: c.fadeIn,
    fadeOut: c.fadeOut,
    volume: c.volume,
    loop: !!c.loop,
    loopCount: c.loopCount || '',
  }));
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* opslag vol of geblokkeerd — negeer */
  }
}

export function loadMeta() {
  try {
    return JSON.parse(localStorage.getItem(META_KEY)) || [];
  } catch {
    return [];
  }
}

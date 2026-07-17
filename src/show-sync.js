// show-sync.js — de gedeelde show bij zelf-hosten.
//
// De server is dan eigenaar van de cue-lijst; elke client toont dezelfde show.
// De lokale IndexedDB blijft in gebruik als cache: afspelen leest de audio van
// schijf, niet over het netwerk. Ontbreekt een bestand lokaal, dan halen we 'm
// eenmalig bij de server op.
//
// Op statische hosting (GitHub Pages) wordt hier niets van gebruikt: daar houdt
// elk apparaat gewoon z'n eigen show.

export async function fetchShow() {
  const res = await fetch('api/show', { cache: 'no-store' });
  if (!res.ok) throw new Error('Kon de show niet ophalen');
  return await res.json();
}

// Stuur de hele show (naam + cue-lijst) naar de server. `appId` markeert ons als
// afzender, zodat we onze eigen wijziging niet als update terugkrijgen.
export async function pushShow(appId, cueMetas, name) {
  const res = await fetch('api/show', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, cues: cueMetas, name }),
  });
  if (!res.ok) throw new Error('Kon de show niet opslaan');
  return await res.json();
}

export async function uploadAudio(id, file) {
  const res = await fetch(`api/audio/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload van "${file.name}" mislukt`);
}

// Bestaat de audio al op de server? (Scheelt onnodig opnieuw uploaden.)
export async function hasAudio(id) {
  try {
    const res = await fetch(`api/audio/${encodeURIComponent(id)}`, { method: 'HEAD', cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function downloadAudio(id, name, type) {
  const res = await fetch(`api/audio/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!res.ok) return null;
  const blob = await res.blob();
  return new File([blob], name || id, { type: type || blob.type || '' });
}

export async function deleteAudio(id) {
  await fetch(`api/audio/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
}

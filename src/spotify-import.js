// Gedeelde validatie voor de Spotify-playlistimport. Zowel de browser als de
// lokale server gebruikt dit: de browser kan meteen een nette fout tonen en de
// server vertrouwt nooit blind op invoer die uiteindelijk naar spotDL gaat.

const PLAYLIST_ID = /^[A-Za-z0-9]{10,64}$/;

export function normalizeSpotifyPlaylistUrl(value) {
  const raw = String(value || '').trim();
  const uri = /^spotify:playlist:([A-Za-z0-9]+)$/i.exec(raw);
  if (uri && PLAYLIST_ID.test(uri[1])) {
    return `https://open.spotify.com/playlist/${uri[1]}`;
  }

  let url;
  try { url = new URL(raw); } catch { return ''; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'open.spotify.com') return '';

  // Spotify deelt normaal /playlist/<id>. Gelokaliseerde links kunnen met een
  // /intl-xx-prefix komen; die accepteren we ook en slaan we canoniek op.
  const parts = url.pathname.split('/').filter(Boolean);
  if (/^intl-[a-z]{2}$/i.test(parts[0] || '')) parts.shift();
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'playlist' || !PLAYLIST_ID.test(parts[1])) return '';
  return `https://open.spotify.com/playlist/${parts[1]}`;
}

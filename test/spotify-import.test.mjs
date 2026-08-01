// Spotify-playlistimport: accepteer alleen echte playlistlinks en maak ze
// canoniek voordat ze naar de lokale spotDL-processen gaan.

import { normalizeSpotifyPlaylistUrl } from '../src/spotify-import.js';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

const id = '37i9dQZF1E8UXBoz02kGID';
const canonical = `https://open.spotify.com/playlist/${id}`;

check('normale playlistlink', normalizeSpotifyPlaylistUrl(`${canonical}?si=abc`) === canonical);
check('gelokaliseerde playlistlink', normalizeSpotifyPlaylistUrl(`https://open.spotify.com/intl-nl/playlist/${id}`) === canonical);
check('Spotify-URI', normalizeSpotifyPlaylistUrl(`spotify:playlist:${id}`) === canonical);
check('track is geen playlist', normalizeSpotifyPlaylistUrl(`https://open.spotify.com/track/${id}`) === '');
check('lookalike-domein geweigerd', normalizeSpotifyPlaylistUrl(`https://open.spotify.com.example/playlist/${id}`) === '');
check('http geweigerd', normalizeSpotifyPlaylistUrl(`http://open.spotify.com/playlist/${id}`) === '');
check('extra pad geweigerd', normalizeSpotifyPlaylistUrl(`${canonical}/meer`) === '');
check('lege invoer geweigerd', normalizeSpotifyPlaylistUrl('') === '');

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} geslaagd, ${fail} gefaald\n`);
process.exit(fail === 0 ? 0 : 1);

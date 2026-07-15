# CueGo

A professional, QLab-style audio cue player that runs entirely in the browser. Audio comes from
your own local files; you play cues in order with the spacebar and fade everything out with **Esc**.
No backend, no account — it works offline, which is exactly what you want during a live show.

## Running it

```bash
cd webqlab
node server.mjs
```

Then open **http://localhost:4321** (Chrome or Edge recommended). The landing page has an
**Open CueGo** button that launches the player (`app.html`).

Different port? `PORT=8080 node server.mjs`

## Pages

- `index.html` — landing page.
- `app.html` — the actual cue player.
- `src/` — the app modules (see *Structure* below).

## Loading audio

Via **Add** (top-right of the player):

- **Choose folder…** — pick one folder; every audio file in it (and its subfolders) becomes a cue. Chrome/Edge.
- **Files…** — pick individual files.
- **Drag & drop** — drop files or folders onto the window.

On import the list is **sorted by the number in the title** (e.g. `01 - Intro`, `02 - Scene`, `10 - Finale`).
New files are appended at the bottom; existing order is kept. You can reorder afterwards by dragging —
a line between the rows shows where the cue will land.

Supported formats: whatever the browser can decode (mp3, wav, m4a, aac, ogg, flac, opus, aiff).

## Controls

| Key / action | What it does |
|---|---|
| **Space** | Play the selected cue and advance the selection (the next cue is selected, not auto-played). Re-triggering a cue restarts it — never two copies of the same cue at once. |
| **Double-click** a cue | Play it immediately |
| **I** | Transition. With **1** cue selected: start it with a chosen fade-in. With **2** selected: crossfade from the first to the second (timed to finish just before the first ends; if the first is already playing it is not restarted). Fade `0` = hard cut. |
| **Esc** | Fade out all playing cues (each over its own fade-out time) |
| **2× Esc** (within 0.6 s) | Stop immediately, no fade |
| **↑ / ↓** | Select previous / next cue |
| **Shift + click** / **Shift + ↑/↓** | Select a range of cues |
| **Delete / Backspace** | Delete the selected cue(s) |
| **F** | Fullscreen on/off |
| Drag a cue | Reorder |

Shortcuts are **editable** under **Settings → Shortcuts** (with a Default and a VLC preset), and can be
saved/loaded as a separate `.webqlabkeys` file.

## The cue inspector

Per cue you can set: number, name, in/out points, fade-in, fade-out, "fade out at end", volume,
loop (with count and crossfade), and auto-continue. It also shows the audio duration and a small
**preview/monitor player** (play/pause + seek) so you can audition the trimmed cue.

- **In/out points** trim the cue; playback, seek and duration all respect the trimmed region.
- **Loop**: infinite (empty count) or N times, with an optional crossfade between iterations.
- **Fade out at end**: fade the cue out over its fade-out time when it reaches its natural end (otherwise only Esc fades).
- **Auto-continue**: automatically start the next cue after a delay when this one finishes.

Edits apply to **all selected cues** at once. Changing the name or number of multiple cues asks for
confirmation first.

## Playback bar & modes

A VLC-style transport bar at the bottom controls the selected cue (play/pause, seekable progress, time).
**Single cue mode** (Settings → Playing) plays only one cue at a time — a new cue fades the previous one
out — and the bar then follows the currently playing cue.

## Projects

Under **Settings → Project**:

- **New…** — start an empty show (asks to save first if there are unsaved changes).
- **Save…** — save the whole show (order, the audio itself, and settings) to one `.webqlab` file. You choose a name.
- **Open…** — load a `.webqlab` file (asks to save first if needed).

Your current show is also **auto-saved between sessions**: audio in IndexedDB, metadata in localStorage,
so a refresh brings everything back. The **project title** next to the logo is click-to-edit.

## Locking

Set a password (Settings → Playing → *Set password*) to lock editing during a show: the padlock in the
top bar then locks/unlocks. When locked, **playback keeps working** but nothing can be edited (adding,
deleting, reordering, the inspector, project changes). Remove the password from the same settings button.

Note: this is a **soft lock** to prevent accidental edits — it is client-side and therefore bypassable
via browser devtools, not real security. The password is stored **hashed** (SHA-256 + salt in a secure
context; a simple hash as fallback on non-HTTPS origins), never in plain text.

## Hosting (static)

CueGo is 100% static — **no backend needed**. All audio processing happens in the browser, so you can
host it on any static host (GitHub Pages, Netlify, …).

GitHub Pages tips: put the custom domain on the **project** repo's Pages settings (not on your
`username.github.io` user-site repo, or it takes over your whole github.io). Because links are relative
(`app.html`, `assets/logo.png`), it works both on a custom domain and on `username.github.io/cuego/`.

Some features need a **secure context** (HTTPS or localhost): the folder picker (File System Access API)
and the strongest password hashing. Over HTTP on a plain IP those degrade gracefully.

## Structure

- `server.mjs` — small static server (Node stdlib), for local development only.
- `src/audio-engine.js` — Web Audio: decode, play, pause/seek, fades, per-cue in/out, loop, crossfade.
- `src/cue-model.js` — cue data model, cue list, sorting, reordering.
- `src/storage.js` — auto-save (IndexedDB + localStorage).
- `src/project.js` — save/open a whole show as one `.webqlab` file.
- `src/app.js` — UI, keyboard, selection, transport, settings, locking, rendering.

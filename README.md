# CueGo

A professional, QLab-style audio cue player that runs entirely in the browser. Audio comes from
your own local files; you play cues in order with the spacebar and fade everything out with **Esc**.
No backend, no account — it works offline, which is exactly what you want during a live show.

## Running it

First time (also installs the `cuego` command and starts the server):

```bash
git clone https://github.com/Jopio0819/cuego.git && cd cuego && node setup.mjs
```

After that, just type `cuego` from any directory (new terminal). The server installs that command
on every start — an alias in your shell profile on macOS/Linux, a `cuego.cmd` in WindowsApps on
Windows — so existing clones get it too. Then open **https://localhost:4321** (Chrome or Edge
recommended). CueGo serves over HTTPS so MIDI and multi-device work from any device on the network;
the first time on each device, accept the one-off self-signed certificate warning (Advanced →
Proceed). If the certificate can't be created for some reason, it falls back to http so the show
still starts.
Running locally takes you **straight into the player** — the landing page is only for the public
static site.

On boot the server checks whether the repo is behind GitHub and **asks** before updating
(`j`/enter to skip). It never blocks a start: no network, no git or a slow GitHub means it just
starts with what it has. Skip the check entirely with `CUEGO_NO_UPDATE_CHECK=1`. If you have local
changes it won't pull over them.

It also asks for an **admin password** on every start (empty = no lock): every device then starts
locked until that password is entered on it (Settings → Security), and remotes must provide it too.

Different port? `PORT=8080 node server.mjs`

## Pages

- `app.html` — the actual cue player. Served at `/` when you run locally.
- `index.html` — landing page, the homepage on static hosting (GitHub Pages). Reachable locally at `/index.html`.
- `404.html` — not-found page (used automatically by GitHub Pages and the local server).
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
saved/loaded as a separate `.cgokeys` file.

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

## Remote control & API

Every way of controlling CueGo goes through the same command bus: `go`, `panic`, `stop`, `play`,
`pause`, `resume`, `toggle`, `select`, `transition`, `playAll`, `state`.

**JavaScript API** — works everywhere, no server needed:

```js
cuego.go()                      // play + select next
cuego.panic()                   // fade everything out (Esc)
cuego.play(3)                   // play cue by number, position, or id
cuego.select('down')            // 'up' | 'down' | 'first' | 'last' | a cue
cuego.state()                   // current state snapshot
cuego.on('cuestart', e => {})   // + cueend, go, panic, statechange, command
```

**MIDI controller** — works in the browser, no server needed. Enable it under **Settings → Control**,
then click a binding and press a button on your controller to learn it (a foot pedal on GO is the
classic setup).

*Workspace control* — bind **GO**, **Panic** (fade out), **Stop**, **Pause**, **Resume**,
play/pause toggle, **Reset** (stop everything and jump back to the first cue), previous/next cue,
transition and play-all.

*Cue triggers* — every cue can have **its own MIDI trigger**, set in the inspector: select a cue,
click the MIDI trigger field and press a pad. That pad then fires that cue directly — the classic
pad-per-cue setup. Triggers are saved with the show (both auto-save and `.cgo` files).

Message types: **Note On**, **Control Change** and **Program Change**, each with its channel. Only
*presses* trigger — note-off, note-on with velocity 0 and CC-release are ignored, so one press is one
command and never two. A button already in use gets *moved* to its new binding (across workspace
actions and cue triggers alike), so one button never fires two things.

Bindings are stored per browser. Chrome/Edge only, and needs a secure context. CueGo serves over
**https** by default, so this is satisfied everywhere — on the show computer and on any other device
on the network — after you accept the one-off certificate warning on that device.

**Network remote** — only when running locally (`node server.mjs`). Open `remote.html` on a phone
or tablet on the same network; the URL is shown under **Settings → Control**:

```
http://<your-ip>:4321/remote.html
```

It has a big GO button, fade out, play/pause, prev/next and a tappable cue list that follows the
show live. Any program can drive CueGo the same way:

```bash
curl -k -X POST https://localhost:4321/api/command \
  -H 'Content-Type: application/json' -d '{"cmd":"go"}'
```

By default **anyone on your network can control the show**. To require a token:

```bash
CUEGO_TOKEN=secret node server.mjs      # then use remote.html?token=secret
```

**OSC** — only when running locally. CueGo listens on **UDP 53000** so a lighting desk, QLab or any
show-control system can drive it. QLab-style addresses work directly; the `/cuego` prefix is optional
and bundles are supported.

| Address | Does |
|---|---|
| `/cue/3/start` | start the cue with number/position 3 (`/cue/3` also works) |
| `/cue/3/select` | select it without playing |
| `/go` | GO (`/go 3` starts cue 3) |
| `/panic` | fade everything out |
| `/stop` · `/reset` | stop immediately · stop and jump back to the first cue |
| `/pause` · `/resume` · `/toggle` | transport |
| `/select/next` · `/select/prev` · `/select/first` · `/select/last` | move the selection |
| `/transition` · `/playAll` | transition · play everything at once |

```bash
CUEGO_OSC_PORT=53001 node server.mjs    # different port (e.g. QLab already has 53000)
CUEGO_OSC=off node server.mjs           # disable OSC
```

OSC has no authentication, so setting `CUEGO_TOKEN` turns OSC **off** — override with `CUEGO_OSC=on`.
If the port is already taken CueGo says so and keeps running without OSC.

Server-dependent features are detected at startup (`/api/ping`) and are **hidden automatically**
when CueGo is hosted statically — on GitHub Pages you only get the JavaScript API.

## Projects

Under **Settings → Project**:

- **New…** — start an empty show (asks to save first if there are unsaved changes).
- **Save…** — save the whole show (order, the audio itself, and settings) to one `.cgo` file. You choose a name.
- **Open…** — load a `.cgo` file (asks to save first if needed).

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

Some features need a **secure context** (https or localhost): Web MIDI, the modern folder picker
and the strongest password hashing. A LAN ip over plain http never qualifies — so when self-hosting,
the server serves **https on the main port (4321)** with a self-signed certificate it generates
itself (pure Node, nothing to install; kept in `cert/`). Open `https://localhost:4321` (or
`https://<ip>:4321` on another device), accept the browser warning once (Advanced → Proceed), and
that device is a full secure context from then on — the certificate is reused across restarts, so
the warning really is one-time per device. It covers `localhost` and the current LAN ip, and is
regenerated automatically when the ip changes or it nears expiry. If the certificate can't be
created, the server falls back to http on the same port so a show never fails to start.

## Structure

- `server.mjs` — static server + control relay (SSE, HTTP, OSC). Node stdlib only, no dependencies.
- `osc.mjs` — OSC packet parser and address → command mapping (server side).
- `src/control.js` — the command bus every input goes through, plus `window.cuego` and server detection.
- `src/net-remote.js` — links the app to the relay: receives commands, pushes state back.
- `src/midi.js` — Web MIDI: message parsing and device handling.
- `src/audio-engine.js` — Web Audio: decode, play, pause/seek, fades, per-cue in/out, loop, crossfade.
- `src/cue-model.js` — cue data model, cue list, sorting, reordering.
- `src/storage.js` — auto-save (IndexedDB + localStorage).
- `src/project.js` — save/open a whole show as one `.cgo` file.
- `src/app.js` — UI, keyboard, selection, transport, settings, locking, rendering.

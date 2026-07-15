# Cue Player

Een professionele, QLab-achtige audio-cuespeler die volledig in de browser draait. Audio komt
lokaal van je computer; je speelt cues op volgorde af met de spatiebalk, en met **Esc** fade je
alles uit. Geen backend nodig — 100% statisch.

## Starten

```bash
cd webqlab
node server.mjs
```

Open daarna **http://localhost:4321** (Chrome of Edge aanbevolen).

Andere poort? `PORT=8080 node server.mjs`

## Audio inladen

Via **Toevoegen** rechtsboven:

- **Map kiezen…** — kies één map; alle audiobestanden (ook in submappen) worden cues. Werkt in Chrome/Edge.
- **Bestanden…** — kies losse bestanden.
- **Slepen** — sleep bestanden of mappen in het venster (er verschijnt een drop-overlay).

Bij importeren wordt de lijst automatisch **gesorteerd op het nummer in de titel**
(bv. `01 - Intro`, `02 - Scene`, `10 - Slot`). Daarna kun je nog handmatig herordenen door te slepen —
een lijn tussen de rijen laat zien waar de cue landt.

Ondersteunde formaten: alles wat je browser kan decoderen (mp3, wav, m4a, aac, ogg, flac, opus, aiff).

## Bediening

| Toets / actie | Wat het doet |
|---|---|
| **Spatie** | Speel de geselecteerde cue en schuif de selectie 1 op (de volgende wordt geselecteerd, maar niet automatisch gestart). Een cue die al speelt wordt herstart — nooit twee keer dezelfde cue tegelijk. |
| **Dubbelklik** op een cue | Direct starten |
| **Esc** | Fade álle spelende cues uit (tijd instelbaar in Instellingen) |
| **2× Esc** (binnen 0,6 s) | Direct stoppen zonder fade |
| **↑ / ↓** | Selecteer vorige/volgende cue |
| **Shift + klik** / **Shift + ↑/↓** | Meerdere cues selecteren (een reeks) |
| **Delete / Backspace** | Verwijder alle geselecteerde cues |
| **Cue slepen** | Volgorde wijzigen |
| **F** of ⛶ | Volledig scherm aan/uit |

Er zijn bewust geen losse GO/Esc-knoppen in beeld — gebruik de sneltoetsen.

Alle sneltoetsen zijn **aanpasbaar** onder **Instellingen → Sneltoetsen**: klik op een toets om 'm
opnieuw in te stellen. Er is een **VLC-preset** (spatie = play/pauze, pijltjes = omhoog/omlaag,
Esc = fade uit) naast de standaard-preset. Je kunt een sneltoets-preset ook **opslaan/openen als
apart bestand** (`.webqlabkeys`), los van het projectbestand.

Het **cue-nummer** pas je aan via het Nr.-veld in de inspector óf door **dubbel te klikken op het
#-vakje** in de tabel.

### Afspeelbalk (onderin)

Een VLC-achtige balk met play/pauze, een sleepbare voortgangsbalk om door te spoelen, en de
huidige tijd / totale duur.

- **Normaal**: de balk bestuurt de **geselecteerde** cue. Klik een cue aan om hem te scrubben.
- **Single cue-modus**: de balk volgt automatisch de cue die op dat moment speelt.

### Inspector

Rechts stel je per cue de naam, fade-in, fade-out en volume in. Wijzigingen worden meteen bewaard.

## Instellingen (⚙)

Een popup met tabbladen:

- **Afspelen** — standaard fade-in, Esc-fade tijd, single cue-modus, en *browser-sneltoetsen
  blokkeren* (voorkomt o.a. Ctrl/Cmd+R; enkele zoals Cmd+W/Q/T kan de browser niet blokkeren).
- **Sneltoetsen** — de aanpasbare keybind-editor met presets (Standaard / VLC) en opslaan/openen
  van een preset-bestand.
- **Project** — de volledige show opslaan/openen (zie hieronder).

## Show opslaan & openen

Onder **Instellingen → Project** sla je de **volledige show** op als één bestand (`.webqlab`):
de volgorde van de cues, de audio zelf én alle instellingen. Met **Openen…** laad je zo'n bestand
weer in — handig als back-up of om een show op een andere computer te gebruiken.

Daarnaast wordt je huidige show **automatisch bewaard** tussen sessies: de audio in IndexedDB, de
metadata in localStorage. Na een refresh laadt alles gewoon terug. Deze automatische opslag staat
lokaal in je browser (per apparaat); gebruik de projectbestanden om te delen of back-uppen.

## Online zetten (Firebase Hosting)

De app is 100% statisch — **geen backend nodig**. Alle audio-verwerking gebeurt in de browser, dus
je kunt het als statische site hosten (Firebase, Netlify, GitHub Pages, …).

```bash
npm install -g firebase-tools
firebase login
cd webqlab
firebase init hosting        # public directory: "." ; single-page app: Nee
firebase deploy
```
Upload `index.html`, `style.css` en `src/` (`testaudio/` en `server.mjs` mag je weglaten — die zijn
alleen voor lokaal testen). Firebase draait op `https`, dus ook **Map kiezen** blijft werken.

## Structuur

- `server.mjs` — kleine statische server (Node stdlib), alleen voor lokaal draaien.
- `src/audio-engine.js` — Web Audio: decoderen, afspelen, pauze/seek, faden. Eén voice per cue.
- `src/cue-model.js` — cue-datamodel, cue-lijst, sorteren, herordenen.
- `src/storage.js` — automatische opslag (IndexedDB + localStorage).
- `src/project.js` — show opslaan/openen als één `.webqlab`-bestand.
- `src/app.js` — UI, toetsenbord, selectie, afspeelbalk, instellingen, rendering.

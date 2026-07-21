# CueGo voor Stream Deck

Bedien een draaiende CueGo-show vanaf je Elgato Stream Deck: GO, stop, pauze,
panic en cues kiezen — met live op de knop welke cue klaarstaat en wat er speelt.

De plugin praat met CueGo via dezelfde API als de webremote (`/api/command` en
`/api/state`). Er verandert dus niets aan CueGo zelf; je hoeft alleen de server te
draaien zoals je gewend bent.

## Wat je nodig hebt

- **Stream Deck 6.4 of nieuwer.** Vanaf die versie kan Stream Deck plugins op
  Node draaien. Node zit er ingebouwd — je hoeft zelf niets te installeren.
- **CueGo draaiend** op deze of een andere computer in het netwerk.

Net als CueGo zelf gebruikt deze plugin **geen enkel npm-pakket**: alles draait op
Node's standaardbibliotheek. Er is dus ook geen buildstap.

## Installeren

Kopieer de map `me.cue-go.sdPlugin` naar de plugin-map van Stream Deck en start
Stream Deck opnieuw op.

**macOS**

```sh
cp -R streamdeck/me.cue-go.sdPlugin \
  ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/
```

**Windows (PowerShell)**

```powershell
Copy-Item -Recurse streamdeck\me.cue-go.sdPlugin `
  "$env:APPDATA\Elgato\StreamDeck\Plugins\"
```

Daarna vind je onder de categorie **CueGo** zeven acties die je op een knop sleept.

## Instellen

Klik een CueGo-knop aan en vul rechts in:

| Veld | Uitleg |
|---|---|
| **Adres** | `127.0.0.1` als CueGo op dezelfde computer draait, anders het IP uit de CueGo-terminal (bv. `192.168.2.90`). |
| **Poort** | Standaard `4321`. |
| **Admin-wachtwoord** | Alleen nodig als je bij het starten van CueGo een wachtwoord hebt ingevuld. Anders leeg laten. |

Dit geldt voor **alle** CueGo-knoppen tegelijk; je hoeft het maar één keer te doen.
Met **Verbinding testen** zie je meteen of het klopt (hij toont de naam van je
project en het aantal cues).

## De acties

| Actie | Wat het doet |
|---|---|
| **GO** | Start de geselecteerde cue. De knop toont welke cue nu klaarstaat. |
| **Stop** | Stopt alles wat er speelt. |
| **Pauze / Hervat** | Pauzeert of hervat. Toont de spelende cue en hoelang die nog duurt; het icoon volgt play/pause. |
| **Panic** | Faadt alles direct uit. |
| **Volgende cue** | Selecteert de volgende cue in de lijst. |
| **Vorige cue** | Selecteert de vorige cue. |
| **Cue afspelen** | Speelt één vaste cue. Vul het cuenummer (`1.5`), het volgnummer (`3`) of de naam in. |

Gaat er iets mis, dan knippert de knop en staat de reden erop: `wachtwoord`,
`remote uit` (de afstandsbediening staat uit in CueGo's instellingen) of `offline`.

## Over het certificaat

CueGo serveert https met een zelfgemaakt certificaat. Dat is niet door een
certificaatautoriteit ondertekend, dus de plugin controleert het certificaat
bewust niet — alleen voor het adres dat jij zelf invult. Zonder dat zou er
überhaupt geen verbinding mogelijk zijn. Draait CueGo op http (de terugvalstand),
dan werkt dat ook: de plugin probeert beide en onthoudt wat werkte.

## Tests

De plugin is getest zonder Stream Deck-hardware, met een nagebootste
Stream Deck-host en een échte CueGo-server:

```sh
node streamdeck/test/ws-rfc.test.mjs       # WebSocket-client tegen RFC 6455
node streamdeck/test/cuego-client.test.mjs # HTTP-client tegen een echte server
node streamdeck/test/plugin.test.mjs       # de hele plugin end-to-end
```

Wat daarmee **niet** gedekt is: hoe de iconen er op de hardware uitzien en of
Stream Deck het manifest accepteert. Dat merk je pas bij het echte installeren.

## Iconen aanpassen

De PNG's staan in de repo, dus normaal hoef je niets te doen. Wil je ze wijzigen,
pas dan `make-icons.mjs` aan (de vormen staan bovenin) en draai:

```sh
node streamdeck/make-icons.mjs
```

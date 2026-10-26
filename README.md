# 🎬 VRT MAX Video & Ondertitels Downloader (GitHub Pages + GitHub Actions)

Een complete webapplicatie waarmee iedereen een **VRT MAX link** kan plakken, op **Inladen** kan klikken, de gevonden **beeldkwaliteiten** (1080p, 720p, 540p, 360p, enkel audio) en/of **ondertitels** (`.srt` / `.vtt`) kan aanvinken, en met één klik op **Download** de aflevering kan opslaan.

---

## 🏗️ Hoe werkt het onder de motorkap (100% gratis)?

1. **GitHub Pages (`public/`)**: Host de statische website gratis.
2. **Gratis Cloudflare Worker (`cloudflare-worker/worker.js`)**: Omdat een publieke website op GitHub Pages geen geheime GitHub Token in de broncode mag hebben, vormt een gratis Cloudflare Worker (tot 100.000 verzoeken per dag gratis) het veilige doorgeefluik tussen de bezoeker en jouw GitHub Actions.
3. **GitHub Actions (`scripts/` + `.github/workflows/vrt-downloader.yml`)**:
   - **Bij klik op "Inladen" (`mode=inspect`)**: Logt in met jouw dummy VRT MAX-account in een headless Playwright-browser (en bewaart de sessie in GitHub Actions Cache zodat volgende pogingen veel sneller zijn), onderschept de `.mpd`/`.m3u8` stream-link, leest met `yt-dlp` alle resoluties uit én haalt direct de `.srt`/`.vtt` ondertitels op.
   - **Bij klik op "Download" (`mode=download`)**:
     - Heb je **ondertitels (`.srt` / `.vtt`)** aangevinkt? Die worden **onmiddellijk (0 seconden wachttijd)** door de browser opgeslagen omdat ze bij het inladen al zijn klaargezet.
     - Heb je een **beeldkwaliteit (bijv. 1080p of 720p)** aangevinkt? Dan geeft GitHub Actions de gevonden `.m3u8` link direct aan `yt-dlp` (zonder Playwright opnieuw te hoeven openen), voegt video en audio samen tot een `.mp4` en zet een directe downloadlink klaar in een tijdelijke GitHub Release (`downloads-cache`). Bestanden ouder dan 3 uur worden automatisch opgeruimd.

---

## 🚀 Volledig Stappenplan om alles online te zetten (€ 0,00)

### Stap 1: Maak een nieuwe GitHub Repository aan
1. Ga naar [github.com/new](https://github.com/new).
2. Geef je repository een naam, bijvoorbeeld **`vrtmax-downloader`**.
3. Zet de repository op **Public** (nodig voor gratis onbeperkte GitHub Actions minuten én gratis GitHub Pages).
4. Upload (of push met Git) alle bestanden uit deze map (`package.json`, `.gitignore`, `.github/`, `scripts/`, `public/`, `cloudflare-worker/`) naar de `main` branch van je nieuwe repository.
   *(Let op: de map `thuis-samenvattingen/` van je vorige project hoef je niet mee te uploaden).*

### Stap 2: Voeg je dummy VRT MAX inloggegevens toe aan GitHub Secrets
1. Ga in je nieuwe GitHub repository naar **Settings** -> **Secrets and variables** -> **Actions**.
2. Klik op **New repository secret** en voeg deze twee secrets toe (dezelfde als in je Thuis-project):
   - **`VRT_EMAIL`**: het e-mailadres van je dummy VRT MAX-account.
   - **`VRT_PASSWORD`**: het wachtwoord van je dummy VRT MAX-account.

### Stap 3: Activeer GitHub Pages
1. Ga in je GitHub repository naar **Settings** -> **Pages**.
2. Kies onder **Build and deployment** bij **Source** voor **GitHub Actions**.
3. De workflow `Deploy Website naar GitHub Pages` (`.github/workflows/deploy-pages.yml`) zet de map `public/` nu automatisch online op `https://<jouw-gebruikersnaam>.github.io/vrtmax-downloader/`.

### Stap 4: Maak een GitHub Personal Access Token aan (voor de Worker)
1. Ga op GitHub rechtsboven naar je profielfoto -> **Settings** -> helemaal onderaan links **Developer settings** -> **Personal access tokens** -> **Fine-grained tokens** (of *Tokens (classic)*).
2. Klik op **Generate new token**:
   - Kies bij **Repository access**: *Only select repositories* -> selecteer **`vrtmax-downloader`**.
   - Geef onder **Repository permissions** deze twee rechten op **Read and write**:
     - **Actions**: `Read and write` (om de workflow te starten)
     - **Contents**: `Read and write` (om de tijdelijke release-bestanden uit te lezen)
3. Kopieer de gegenereerde token (`github_pat_...` of `ghp_...`).

### Stap 5: Zet de gratis tussenstap (Cloudflare Worker) online (duurt 2 minuten)
1. Maak een gratis account aan op [dash.cloudflare.com](https://dash.cloudflare.com/) (geen betaalkaart nodig).
2. Klik in het linkermenu op **Workers & Pages** -> **Create** -> **Create Worker**.
3. Geef je Worker een naam (bijv. `vrtmax-downloader`) en klik op **Deploy**.
4. Klik op **Edit code**, verwijder de voorbeeldcode, en plak de volledige inhoud van [`cloudflare-worker/worker.js`](./cloudflare-worker/worker.js). Klik rechtsboven op **Deploy**.
5. Ga terug naar het overzicht van je Worker -> tabblad **Settings** -> **Variables and Secrets** en voeg deze 3 variabelen toe:
   - **`GITHUB_OWNER`**: jouw GitHub-gebruikersnaam (bijv. `robbesonck`)
   - **`GITHUB_REPO`**: de naam van je repository (bijv. `vrtmax-downloader`)
   - **`GITHUB_TOKEN`**: plak hier je GitHub Token uit Stap 4 (kies type *Secret* / *Encrypt*).
6. Kopieer de URL van je Worker (bijv. `https://vrtmax-downloader.jouwnaam.workers.dev`).

### Stap 6: Koppel de Worker-URL aan je website
1. Open [`public/app.js`](./public/app.js) op regel 9:
   ```js
   const DEFAULT_WORKER_URL = 'https://vrtmax-downloader.jouwnaam.workers.dev';
   ```
2. Commit en push deze wijziging naar GitHub (of vul de URL direct op de website in via de knop **⚙️ API Instellingen** rechtsboven).
3. Klaar! Elke bezoeker kan nu een VRT MAX-link plakken, op **Inladen** klikken, de gewenste kwaliteit en/of ondertitels aanvinken en op **Download** drukken.

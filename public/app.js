/**
 * VRT MAX Video & Ondertitels Downloader — Frontend Logica (GitHub Pages)
 *
 * TIP: Zodra je jouw gratis Cloudflare Worker hebt aangemaakt (zie het stappenplan in README.md),
 * plak je de URL van die Worker hieronder bij DEFAULT_WORKER_URL.
 * Dan werkt de website meteen voor elke bezoeker zonder dat iemand iets hoeft in te stellen!
 */
const DEFAULT_WORKER_URL = 'https://vrtmax-downloader.robberttus.workers.dev';

const STORAGE_WORKER_KEY = 'vrtmax_worker_url';

// State van de momenteel ingeladen aflevering
let currentLoadedData = null;
let selectedQuality = null;

// DOM Elementen
const inspectForm = document.getElementById('inspectForm');
const vrtUrlInput = document.getElementById('vrtUrlInput');
const pasteBtn = document.getElementById('pasteBtn');
const inspectBtn = document.getElementById('inspectBtn');

const inspectProgressBox = document.getElementById('inspectProgressBox');
const inspectStatusTitle = document.getElementById('inspectStatusTitle');
const inspectStatusSub = document.getElementById('inspectStatusSub');
const inspectProgressBar = document.getElementById('inspectProgressBar');
const stepQueue = document.getElementById('stepQueue');
const stepBrowser = document.getElementById('stepBrowser');
const stepFormats = document.getElementById('stepFormats');

const errorAlert = document.getElementById('errorAlert');
const errorMessage = document.getElementById('errorMessage');

const resultSection = document.getElementById('resultSection');
const epThumbnail = document.getElementById('epThumbnail');
const epProgramBadge = document.getElementById('epProgramBadge');
const epDurationBadge = document.getElementById('epDurationBadge');
const epDateBadge = document.getElementById('epDateBadge');
const epTitle = document.getElementById('epTitle');
const epDescription = document.getElementById('epDescription');
const drmWarning = document.getElementById('drmWarning');

const videoOptionPanel = document.getElementById('videoOptionPanel');
const checkDownloadVideo = document.getElementById('checkDownloadVideo');
const qualityListContainer = document.getElementById('qualityListContainer');
const qualitiesList = document.getElementById('qualitiesList');
const checkEmbedSubs = document.getElementById('checkEmbedSubs');

const subtitleOptionPanel = document.getElementById('subtitleOptionPanel');
const checkDownloadSubs = document.getElementById('checkDownloadSubs');
const subtitleAvailabilityText = document.getElementById('subtitleAvailabilityText');
const subtitleOptionsBody = document.getElementById('subtitleOptionsBody');
const checkSubSrt = document.getElementById('checkSubSrt');
const checkSubVtt = document.getElementById('checkSubVtt');
const subtitlePreviewBox = document.getElementById('subtitlePreviewBox');
const subtitlePreviewText = document.getElementById('subtitlePreviewText');

const selectionSummary = document.getElementById('selectionSummary');
const downloadBtn = document.getElementById('downloadBtn');
const downloadProgressBox = document.getElementById('downloadProgressBox');
const downloadStatusTitle = document.getElementById('downloadStatusTitle');
const downloadStatusSub = document.getElementById('downloadStatusSub');
const downloadProgressBar = document.getElementById('downloadProgressBar');
const downloadReadyBox = document.getElementById('downloadReadyBox');
const readyTitle = document.getElementById('readyTitle');
const readyMeta = document.getElementById('readyMeta');
const directDownloadLink = document.getElementById('directDownloadLink');

const rawM3u8Input = document.getElementById('rawM3u8Input');
const rawYtdlpCmdInput = document.getElementById('rawYtdlpCmdInput');
const copyM3u8Btn = document.getElementById('copyM3u8Btn');
const copyCmdBtn = document.getElementById('copyCmdBtn');

// Config Modal
const openConfigBtn = document.getElementById('openConfigBtn');
const closeConfigBtn = document.getElementById('closeConfigBtn');
const configModal = document.getElementById('configModal');
const workerUrlInput = document.getElementById('workerUrlInput');
const saveConfigBtn = document.getElementById('saveConfigBtn');

function getWorkerUrl() {
  const saved = localStorage.getItem(STORAGE_WORKER_KEY);
  return (saved || DEFAULT_WORKER_URL || '').trim().replace(/\/$/, '');
}

function showError(msg) {
  errorMessage.textContent = msg;
  errorAlert.classList.remove('hidden');
}

function hideError() {
  errorAlert.classList.add('hidden');
}

function formatDuration(sec) {
  if (!sec || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return `${h}u ${remM}m`;
  }
  return `${m} min ${s > 0 ? `${s}s` : ''}`.trim();
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('nl-BE', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

function srtToVtt(srtText) {
  if (!srtText) return '';
  const body = srtText
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}`;
}

function triggerBrowserTextDownload(content, filename, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Plak-knop
pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) vrtUrlInput.value = text.trim();
  } catch {
    vrtUrlInput.focus();
  }
});

// Config Modal
openConfigBtn.addEventListener('click', () => {
  workerUrlInput.value = getWorkerUrl();
  configModal.classList.remove('hidden');
});

closeConfigBtn.addEventListener('click', () => {
  configModal.classList.add('hidden');
});

saveConfigBtn.addEventListener('click', () => {
  const val = workerUrlInput.value.trim().replace(/\/$/, '');
  if (val) {
    localStorage.setItem(STORAGE_WORKER_KEY, val);
  } else {
    localStorage.removeItem(STORAGE_WORKER_KEY);
  }
  configModal.classList.add('hidden');
});

// Update visuele staat van de aanvinkopties & samenvattingsbalk
function updateSelectionUI() {
  const wantVideo = checkDownloadVideo.checked;
  const wantSubs = checkDownloadSubs.checked && currentLoadedData?.subtitles?.available;

  videoOptionPanel.classList.toggle('panel-active', wantVideo);
  qualityListContainer.classList.toggle('disabled-panel', !wantVideo);

  subtitleOptionPanel.classList.toggle('panel-active', Boolean(wantSubs));
  subtitleOptionsBody.classList.toggle('disabled-panel', !wantSubs);

  const parts = [];
  if (wantVideo && selectedQuality) {
    const ext = selectedQuality.audioOnly ? '.m4a' : '.mp4';
    const embedNote = !selectedQuality.audioOnly && checkEmbedSubs.checked ? ' (incl. ingebakken subs)' : '';
    parts.push(`<strong>${selectedQuality.label} (${ext})${embedNote}</strong>`);
  }

  if (wantSubs) {
    const subExts = [];
    if (checkSubSrt.checked) subExts.push('.srt');
    if (checkSubVtt.checked) subExts.push('.vtt');
    if (subExts.length > 0) {
      parts.push(`<strong>Ondertitels (${subExts.join(' + ')})</strong>`);
    }
  }

  if (parts.length === 0) {
    selectionSummary.innerHTML = 'Vink minstens één optie aan om te downloaden.';
    downloadBtn.disabled = true;
  } else {
    selectionSummary.innerHTML = `Geselecteerd: ${parts.join(' + ')}`;
    downloadBtn.disabled = false;
  }

  // Update geavanceerd yt-dlp commando
  if (currentLoadedData?.m3u8Url) {
    const h = selectedQuality?.height || 1080;
    const safeName = currentLoadedData.metadata?.safeFilename || 'vrtmax-aflevering';
    if (selectedQuality?.audioOnly) {
      rawYtdlpCmdInput.value = `yt-dlp -f "bestaudio/best" -x --audio-format m4a -o "${safeName}.%(ext)s" "${currentLoadedData.m3u8Url}"`;
    } else {
      rawYtdlpCmdInput.value = `yt-dlp -f "bestvideo[height<=${h}]+bestaudio/best[height<=${h}]" --merge-output-format mp4 --write-subs --convert-subs srt -o "${safeName}.%(ext)s" "${currentLoadedData.m3u8Url}"`;
    }
  }
}

checkDownloadVideo.addEventListener('change', updateSelectionUI);
checkDownloadSubs.addEventListener('change', updateSelectionUI);
checkEmbedSubs.addEventListener('change', updateSelectionUI);
checkSubSrt.addEventListener('change', updateSelectionUI);
checkSubVtt.addEventListener('change', updateSelectionUI);

// Render de ingeladen aflevering en kwaliteiten
function renderInspectResult(data) {
  currentLoadedData = data;
  const meta = data.metadata || {};

  epTitle.textContent = meta.title || 'VRT MAX Aflevering';
  epProgramBadge.textContent = meta.programTitle || 'VRT MAX';
  epDescription.textContent = meta.description || '';

  const durText = formatDuration(meta.durationSeconds);
  epDurationBadge.textContent = durText;
  epDurationBadge.classList.toggle('hidden', !durText);

  const dateText = formatDate(meta.broadcastDate);
  epDateBadge.textContent = dateText;
  epDateBadge.classList.toggle('hidden', !dateText);

  if (meta.thumbnailUrl) {
    epThumbnail.src = meta.thumbnailUrl;
    epThumbnail.classList.remove('hidden');
  } else {
    epThumbnail.classList.add('hidden');
  }

  drmWarning.classList.toggle('hidden', !data.drmDetected);

  // Render beeldkwaliteiten
  qualitiesList.innerHTML = '';
  const qualities = Array.isArray(data.qualities) && data.qualities.length > 0 ? data.qualities : [];
  selectedQuality = qualities[0] || null;

  qualities.forEach((q, idx) => {
    const card = document.createElement('label');
    card.className = `quality-card ${idx === 0 ? 'selected' : ''}`;

    const sizeTag = q.estimatedSizeMb ? `± ${q.estimatedSizeMb} MB` : q.tbr ? `${q.tbr} kbps` : 'MP4';

    card.innerHTML = `
      <div class="quality-card-left">
        <input type="radio" name="videoQuality" value="${q.id}" ${idx === 0 ? 'checked' : ''} />
        <div>
          <div class="quality-title">${q.label}</div>
          <div class="quality-sub">${q.resolution}${q.tbr ? ` • ${q.tbr} kbps` : ''}</div>
        </div>
      </div>
      <span class="quality-badge">${sizeTag}</span>
    `;

    const radio = card.querySelector('input');
    radio.addEventListener('change', () => {
      document.querySelectorAll('.quality-card').forEach((el) => el.classList.remove('selected'));
      card.classList.add('selected');
      selectedQuality = q;
      updateSelectionUI();
    });

    qualitiesList.appendChild(card);
  });

  // Render ondertitel-opties
  const hasSubs = Boolean(data.subtitles?.available && data.subtitles?.srtContent);
  checkDownloadSubs.checked = hasSubs;
  checkDownloadSubs.disabled = !hasSubs;

  if (hasSubs) {
    subtitleAvailabilityText.textContent = 'Nederlandse ondertitels gevonden — direct (0 sec) te downloaden!';
    subtitlePreviewBox.classList.remove('hidden');
    subtitlePreviewText.textContent = data.subtitles.srtContent.slice(0, 450).trim() + '\n...';
  } else {
    subtitleAvailabilityText.textContent = 'Geen ondertitelspoor gevonden voor deze aflevering.';
    subtitlePreviewBox.classList.add('hidden');
  }

  rawM3u8Input.value = data.m3u8Url || '';
  updateSelectionUI();

  downloadProgressBox.classList.add('hidden');
  downloadReadyBox.classList.add('hidden');
  resultSection.classList.remove('hidden');
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Poll een jobId bij de Cloudflare Worker tot status READY of ERROR is
async function pollJobUntilDone(workerUrl, jobId, onTick) {
  const startTime = Date.now();
  const maxWaitMs = 20 * 60 * 1000; // Max 20 minuten voor grote downloads

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 3500));

    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    if (onTick) onTick(elapsedSec);

    try {
      const res = await fetch(`${workerUrl}/api/status?jobId=${encodeURIComponent(jobId)}`);
      if (!res.ok) continue;
      const data = await res.json();

      if (data.status === 'READY') {
        return data;
      }
      if (data.status === 'ERROR') {
        throw new Error(data.error || 'De taak op GitHub Actions gaf een foutmelding.');
      }
    } catch (err) {
      if (err.message && !err.message.includes('Failed to fetch')) {
        throw err;
      }
    }
  }

  throw new Error('Time-out: De verwerking op GitHub Actions duurde langer dan verwacht.');
}

// STAP 1: Formulier "Inladen"
inspectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  const vrtUrl = vrtUrlInput.value.trim();
  if (!vrtUrl.includes('vrt.be/vrtmax')) {
    showError('Plak een geldige VRT MAX link (bijv. https://www.vrt.be/vrtmax/a-z/...).');
    return;
  }

  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    configModal.classList.remove('hidden');
    showError('Stel eerst eenmalig je Cloudflare Worker URL in via de knop "⚙️ API Instellingen" rechtsboven.');
    return;
  }

  inspectBtn.disabled = true;
  resultSection.classList.add('hidden');
  inspectProgressBox.classList.remove('hidden');
  inspectProgressBar.style.width = '12%';
  stepQueue.classList.add('active');
  stepBrowser.classList.remove('active');
  stepFormats.classList.remove('active');

  try {
    const startRes = await fetch(`${workerUrl}/api/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: vrtUrl }),
    });

    const startData = await startRes.json();
    if (!startRes.ok || startData.error) {
      throw new Error(startData.error || 'Kon de Inladen-actie niet starten.');
    }

    const jobData = await pollJobUntilDone(workerUrl, startData.jobId, (elapsedSec) => {
      const pct = Math.min(92, 15 + Math.round((elapsedSec / 40) * 75));
      inspectProgressBar.style.width = `${pct}%`;

      if (elapsedSec > 8) {
        stepBrowser.classList.add('active');
        inspectStatusTitle.textContent = 'Headless browser logt in op VRT MAX en zoekt stream...';
      }
      if (elapsedSec > 20) {
        stepFormats.classList.add('active');
        inspectStatusTitle.textContent = 'Beschikbare beeldkwaliteiten & ondertitels uitlezen met yt-dlp...';
      }
    });

    inspectProgressBar.style.width = '100%';
    inspectProgressBox.classList.add('hidden');
    renderInspectResult(jobData);
  } catch (err) {
    inspectProgressBox.classList.add('hidden');
    showError(err.message || 'Er ging iets mis bij het inladen van de VRT MAX link.');
  } finally {
    inspectBtn.disabled = false;
  }
});

// STAP 2: Klik op "Download geselecteerde opties"
downloadBtn.addEventListener('click', async () => {
  if (!currentLoadedData) return;
  hideError();

  const wantVideo = checkDownloadVideo.checked && selectedQuality;
  const wantSubs = checkDownloadSubs.checked && currentLoadedData.subtitles?.available;
  const safeName = currentLoadedData.metadata?.safeFilename || 'vrtmax-aflevering';

  // 1. Download aangevinkte ondertitels DIRECT in de browser (0 seconden wachttijd!)
  if (wantSubs && currentLoadedData.subtitles?.srtContent) {
    const srtContent = currentLoadedData.subtitles.srtContent;
    if (checkSubSrt.checked) {
      triggerBrowserTextDownload(srtContent, `${safeName}.nl.srt`, 'application/x-subrip;charset=utf-8');
    }
    if (checkSubVtt.checked) {
      const vttContent = srtToVtt(srtContent);
      triggerBrowserTextDownload(vttContent, `${safeName}.nl.vtt`, 'text/vtt;charset=utf-8');
    }
  }

  // Als de gebruiker enkel ondertitels had aangevinkt, zijn we meteen klaar!
  if (!wantVideo) {
    return;
  }

  // 2. Start de video/audio download op GitHub Actions voor de gekozen kwaliteit
  const workerUrl = getWorkerUrl();
  downloadBtn.disabled = true;
  downloadReadyBox.classList.add('hidden');
  downloadProgressBox.classList.remove('hidden');
  downloadProgressBar.style.width = '15%';
  downloadStatusTitle.textContent = `${selectedQuality.label} wordt gedownload en samengevoegd met yt-dlp...`;

  try {
    const startRes = await fetch(`${workerUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vrtUrl: currentLoadedData.metadata?.url || vrtUrlInput.value.trim(),
        m3u8Url: currentLoadedData.m3u8Url,
        qualityId: selectedQuality.id,
        height: selectedQuality.height || 1080,
        audioOnly: Boolean(selectedQuality.audioOnly),
        embedSubs: Boolean(checkEmbedSubs.checked),
        title: safeName,
      }),
    });

    const startData = await startRes.json();
    if (!startRes.ok || startData.error) {
      throw new Error(startData.error || 'Kon de video-download niet starten.');
    }

    const doneData = await pollJobUntilDone(workerUrl, startData.jobId, (elapsedSec) => {
      const pct = Math.min(94, 15 + Math.round((elapsedSec / 75) * 78));
      downloadProgressBar.style.width = `${pct}%`;
      downloadStatusSub.textContent = `Bezig op GitHub Actions (${elapsedSec}s verstreken)... yt-dlp downloadt en muxt de gekozen stream.`;
    });

    downloadProgressBar.style.width = '100%';
    downloadProgressBox.classList.add('hidden');

    if (doneData.downloadUrl) {
      const sizeMb = doneData.sizeBytes ? `${Math.round(doneData.sizeBytes / 1024 / 1024)} MB` : '';
      readyTitle.textContent = `Download klaar: ${doneData.fileName || safeName}`;
      readyMeta.textContent = `${selectedQuality.label} ${sizeMb ? `• ${sizeMb}` : ''} — Klik op de knop hiernaast als het opslaan niet automatisch startte.`;
      directDownloadLink.href = doneData.downloadUrl;
      downloadReadyBox.classList.remove('hidden');

      // Start de download ook meteen automatisch in de browser
      const autoLink = document.createElement('a');
      autoLink.href = doneData.downloadUrl;
      autoLink.download = doneData.fileName || '';
      document.body.appendChild(autoLink);
      autoLink.click();
      autoLink.remove();
    }
  } catch (err) {
    downloadProgressBox.classList.add('hidden');
    showError(err.message || 'Er ging iets mis tijdens het downloaden van de video.');
  } finally {
    downloadBtn.disabled = false;
  }
});

// Kopieerknoppen in Geavanceerd paneel
copyM3u8Btn.addEventListener('click', () => {
  navigator.clipboard.writeText(rawM3u8Input.value || '');
  copyM3u8Btn.textContent = '✓ Gekopieerd!';
  setTimeout(() => (copyM3u8Btn.textContent = 'Kopieer URL'), 2000);
});

copyCmdBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(rawYtdlpCmdInput.value || '');
  copyCmdBtn.textContent = '✓ Gekopieerd!';
  setTimeout(() => (copyCmdBtn.textContent = 'Kopieer commando'), 2000);
});

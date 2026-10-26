import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const ROOT_DIR = process.cwd();
export const AUTH_STATE_PATH = path.join(ROOT_DIR, '.auth', 'vrt-state.json');

/**
 * Controleert of een bestand bestaat.
 */
export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Maakt een veilige bestandsnaam van een programmatitel.
 */
export function sanitizeFilename(name) {
  return (
    (name || 'vrtmax-video')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 90) || 'vrtmax-video'
  );
}

/**
 * Hulpfunctie voor fetch met automatische retry bij tijdelijke VRT CDN 502/503/504 fouten.
 */
export async function fetchWithRetry(url, options = {}, retries = 4, delayMs = 2000) {
  let lastRes = null;
  let lastErr = null;
  const urlsToTry = [url];
  if (url.includes('://vod.vrtcdn.be/ondemand/')) {
    urlsToTry.push(url.replace('://vod.vrtcdn.be/ondemand/', '://ondemand.vrtcdn.be/'));
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    const candidateUrl = urlsToTry[(attempt - 1) % urlsToTry.length];
    try {
      const res = await fetch(candidateUrl, options);
      if (res.ok) return res;
      lastRes = res;
      console.warn(`   ⏳ VRT server gaf status ${res.status} (poging ${attempt}/${retries}), even wachten...`);
    } catch (err) {
      lastErr = err;
      console.warn(`   ⏳ Netwerkfout bij poging ${attempt}/${retries}: ${err.message}`);
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }

  if (lastRes) return lastRes;
  throw lastErr || new Error(`Kon ${url} niet ophalen na ${retries} pogingen.`);
}

/**
 * Accepteert de VRT cookiebanner (cmp-sp.vrt.be iframe of pagina) in de virtuele browser indien aanwezig.
 */
export async function acceptCookiesIfNeeded(page) {
  try {
    const frames = [page, ...page.frames()];
    for (const frame of frames) {
      const acceptBtn = frame
        .locator(
          'button[title*="Akkoord"], button:has-text("Alles accepteren"), button:has-text("Akkoord"), button:has-text("Aanvaarden"), .sp_choice_type_11'
        )
        .first();
      if (await acceptBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await acceptBtn.click().catch(() => {});
        await page.waitForTimeout(800);
        return;
      }
    }
  } catch {
    // Geen cookiebanner zichtbaar
  }
}

/**
 * Hulpfunctie om een virtuele browsersessie te openen (inclusief opgeslagen login-state indien aanwezig).
 */
export async function launchVrtBrowser({ headless = true } = {}) {
  const hasState = await fileExists(AUTH_STATE_PATH);
  const browser = await chromium.launch({
    headless,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--use-gl=swiftshader',
    ],
  });
  const context = await browser.newContext({
    ...(hasState ? { storageState: AUTH_STATE_PATH } : {}),
    locale: 'nl-BE',
    timezoneId: 'Europe/Brussels',
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * Logt in op VRT MAX in de virtuele browser met VRT_EMAIL en VRT_PASSWORD.
 */
export async function ensureLoggedIn(page, context, { email, password }) {
  console.log('🔍 Controleren of we ingelogd zijn op VRT MAX...');
  await page.goto('https://www.vrt.be/vrtmax/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  await acceptCookiesIfNeeded(page);

  const cookies = await context.cookies('https://www.vrt.be');
  const hasVideoToken = cookies.some((c) => c.name === 'vrtnu-site_profile_vt' && c.value);
  if (hasVideoToken) {
    console.log('✅ Al ingelogd op VRT MAX (geldige sessie gevonden).');
    return;
  }

  if (!email || !password) {
    throw new Error('Niet ingelogd op VRT MAX en geen VRT_EMAIL / VRT_PASSWORD opgegeven!');
  }

  console.log('🔐 Inloggen op VRT MAX via de virtuele browser...');
  await page.goto(
    'https://www.vrt.be/vrtmax/sso/login?resumePage=https%3A%2F%2Fwww.vrt.be%2Fvrtmax%2F',
    { waitUntil: 'domcontentloaded', timeout: 45000 }
  );

  await page.waitForTimeout(1500);
  await acceptCookiesIfNeeded(page);

  const emailInput = page
    .locator('input[type="email"], input[name="email"], input[name="loginID"]')
    .first();
  await emailInput.waitFor({ state: 'visible', timeout: 20000 });
  await emailInput.fill(email);

  const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
  await passwordInput.waitFor({ state: 'visible', timeout: 10000 });
  await passwordInput.fill(password);

  const submitBtn = page.locator('button[type="submit"], button:has-text("Aanmelden")').first();
  await submitBtn.click();

  await page.waitForTimeout(4500);
  await acceptCookiesIfNeeded(page);

  try {
    if (page.url().includes('profiel') || page.url().includes('subprofile')) {
      const profileBtn = page
        .locator('[data-testid*="profile"], .profile-tile, main button')
        .first();
      if (await profileBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
        await profileBtn.click();
        await page.waitForTimeout(2500);
      }
    }
  } catch {
    // Geen profielkeuze nodig
  }

  await page
    .waitForURL((url) => url.hostname.includes('vrt.be') && !url.hostname.includes('login.vrt.be'), {
      timeout: 30000,
    })
    .catch(() => {});
  await page.waitForTimeout(2000);

  const updatedCookies = await context.cookies('https://www.vrt.be');
  const loggedIn = updatedCookies.some((c) => c.name === 'vrtnu-site_profile_vt' && c.value);

  if (!loggedIn) {
    const errorText = await page
      .locator('[role="alert"], .error, .message--error')
      .first()
      .textContent()
      .catch(() => '');
    throw new Error(
      `Inloggen op VRT MAX mislukt. ${
        errorText ? `Melding: ${errorText.trim()}` : 'Controleer VRT_EMAIL en VRT_PASSWORD.'
      }`
    );
  }

  await fs.mkdir(path.dirname(AUTH_STATE_PATH), { recursive: true });
  await context.storageState({ path: AUTH_STATE_PATH });
  console.log('✅ Succesvol ingelogd op VRT MAX en sessie opgeslagen!');
}

/**
 * Haalt universele metadata op van gelijk welke VRT MAX afleveringspagina.
 */
export async function extractUniversalMetadata(page, episodeUrl) {
  let meta = null;

  if (page) {
    meta = await page
      .evaluate(() => {
        const result = {
          title: null,
          programTitle: null,
          season: null,
          episodeNumber: null,
          description: null,
          broadcastDate: null,
          durationSeconds: null,
          thumbnailUrl: null,
        };

        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        for (const s of scripts) {
          try {
            const json = JSON.parse(s.textContent);
            if (json['@type'] === 'TVEpisode' || json['@type'] === 'VideoObject' || json.video || json.publication) {
              result.title = json.name || result.title;
              result.programTitle = json.partOfSeries?.name || result.programTitle;
              result.season = json.partOfSeason?.seasonNumber || result.season;
              result.episodeNumber = json.episodeNumber || result.episodeNumber;
              result.description = (json.description || '').replace(/<[^>]+>/g, '').trim() || result.description;
              result.broadcastDate =
                json.publication?.[0]?.startDate || json.video?.uploadDate || json.uploadDate || result.broadcastDate;
              result.thumbnailUrl =
                (Array.isArray(json.video?.thumbnailUrl) ? json.video.thumbnailUrl[0] : json.video?.thumbnailUrl) ||
                (Array.isArray(json.thumbnailUrl) ? json.thumbnailUrl[0] : json.thumbnailUrl) ||
                result.thumbnailUrl;
            }
          } catch {}
        }

        const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
        const ogDesc = document.querySelector('meta[property="og:description"]')?.content;
        const ogImage = document.querySelector('meta[property="og:image"]')?.content;

        if (!result.title) result.title = ogTitle || document.title?.replace(/\s*\|\s*VRT MAX.*$/i, '') || 'VRT MAX Aflevering';
        if (!result.description) result.description = ogDesc || '';
        if (!result.thumbnailUrl) result.thumbnailUrl = ogImage || null;

        return result;
      })
      .catch(() => null);
  }

  return {
    url: episodeUrl,
    title: meta?.title || 'VRT MAX Aflevering',
    programTitle: meta?.programTitle || '',
    season: meta?.season || null,
    episodeNumber: meta?.episodeNumber || null,
    description: meta?.description || '',
    broadcastDate: meta?.broadcastDate || null,
    thumbnailUrl: meta?.thumbnailUrl || null,
  };
}

/**
 * Opent gelijk welke VRT MAX URL in de headless browser en achterhaalt de .mpd en .m3u8 stream-link.
 */
export async function findVrtMaxStream(page, targetUrl) {
  console.log(`\n🌐 Openen van VRT MAX pagina: ${targetUrl}`);

  let capturedStreamUrl = null;
  let streamErrorCode = null;
  let drmDetected = false;

  const onRequest = (request) => {
    const url = request.url();
    if (
      !url.includes('live-radio') &&
      (url.includes('.ism/.mpd') ||
        url.includes('.ism/.m3u8') ||
        url.includes('.isml/.mpd') ||
        url.includes('.isml/.m3u8'))
    ) {
      if (!capturedStreamUrl) {
        capturedStreamUrl = url;
        console.log(`🎯 [Stream-link gevonden in netwerkverkeer]: ${url}`);
      }
    }
  };

  const onResponse = async (response) => {
    const url = response.url();
    if (
      response.status() >= 200 &&
      response.status() < 300 &&
      (url.includes('media-aggregator/v2/media-items/') ||
        url.includes('vualto-video-aggregator-web/rest/external/v2/videos/') ||
        url.includes('/media-items/'))
    ) {
      try {
        const data = await response.json();
        if (data?.drm) {
          drmDetected = true;
        }
        if (data?.targetUrls && Array.isArray(data.targetUrls)) {
          const hls = data.targetUrls.find((t) => t.type === 'hls' || t.url?.includes('.m3u8'));
          const dash = data.targetUrls.find((t) => t.type === 'mpeg_dash' || t.url?.includes('.mpd'));
          const chosen = hls || dash || data.targetUrls[0];
          if (chosen?.url && !capturedStreamUrl) {
            capturedStreamUrl = chosen.url;
            console.log(`🎯 [Stream-link onderschept uit VRT media-items API]: ${capturedStreamUrl}`);
          }
        } else if (data?.code) {
          streamErrorCode = data.code;
        }
      } catch {}
    }
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  try {
    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    const waitStart = Date.now();
    while (!capturedStreamUrl && !streamErrorCode && Date.now() - waitStart < 5000) {
      await page.waitForTimeout(300);
    }

    const pageTitle = await page.title();
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (
      response?.status() === 404 ||
      pageTitle.toLowerCase().includes('niet gevonden') ||
      bodyText.includes('Deze pagina werd niet gevonden') ||
      bodyText.includes('Oeps, deze pagina bestaat niet')
    ) {
      throw new Error('Deze VRT MAX pagina werd niet gevonden (404). Controleer de geplakte link.');
    }

    await acceptCookiesIfNeeded(page);
    const metadata = await extractUniversalMetadata(page, page.url());

    // Directe browser-sessie API poging (werkt voor elke afleveringspagina op VRT MAX)
    if (!capturedStreamUrl) {
      try {
        const currentPathname = new URL(page.url()).pathname;
        const directData = await page.evaluate(async (epPath) => {
          const gqlRes = await fetch('https://www.vrt.be/vrtnu-api/graphql/public/v1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-vrt-client-name': 'WEB' },
            body: JSON.stringify({
              query: `{ page(id: "${epPath}") { ... on EpisodePage { ldjson } } }`,
            }),
          });
          const gqlData = await gqlRes.json();
          let publicationId = null;
          let videoId = null;
          for (const item of gqlData?.data?.page?.ldjson || []) {
            try {
              const p = JSON.parse(item);
              if (p.video?.['@id']) videoId = p.video['@id'];
              if (p.publication?.[0]?.['@id']) publicationId = p.publication[0]['@id'];
            } catch {}
          }
          if (!publicationId || !videoId) return null;

          const cookieMatch = document.cookie.match(/vrtnu-site_profile_vt=([^;]+)/);
          if (!cookieMatch) return null;
          const identityToken = cookieMatch[1];

          const tokenRes = await fetch(
            'https://media-services-public.vrt.be/vualto-video-aggregator-web/rest/external/v2/tokens',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ identityToken }),
            }
          );
          const tokenData = await tokenRes.json();
          if (!tokenData.vrtPlayerToken) return null;

          const mediaRes = await fetch(
            `https://media-services-public.vrt.be/media-aggregator/v2/media-items/${publicationId}$${videoId}?client=vrtnu-web%40PROD&vrtPlayerToken=${tokenData.vrtPlayerToken}`
          );
          return await mediaRes.json();
        }, currentPathname);

        if (directData?.drm) drmDetected = true;
        if (directData?.targetUrls && Array.isArray(directData.targetUrls)) {
          const hls = directData.targetUrls.find((t) => t.type === 'hls' || t.url?.includes('.m3u8'));
          const dash = directData.targetUrls.find((t) => t.type === 'mpeg_dash' || t.url?.includes('.mpd'));
          const chosen = hls || dash || directData.targetUrls[0];
          if (chosen?.url) {
            capturedStreamUrl = chosen.url;
            console.log(`🎯 [Stream-link via browser-sessie API opgelost]: ${capturedStreamUrl}`);
          }
        }
      } catch (evalErr) {
        console.warn(`   (Directe browser-API poging overgeslagen: ${evalErr.message})`);
      }
    }

    // Als nog niet onderschept, klik op Play in de videospeler
    if (!capturedStreamUrl) {
      console.log('▶️ Klikken op Play in de videospeler...');
      await page
        .evaluate(() => {
          const videos = document.querySelectorAll('video');
          videos.forEach((v) => v.play().catch(() => {}));
          const player = document.querySelector('vrt-media-player-web-ui');
          if (player) {
            player.click();
            const innerBtn = player.shadowRoot?.querySelector('button, [role="button"], video');
            if (innerBtn) innerBtn.click();
          }
        })
        .catch(() => {});

      const playSelectors = [
        'vrt-media-player-web-ui',
        'button[aria-label*="Afspelen"]',
        'button[aria-label*="Play"]',
        'button[aria-label*="Bekijk"]',
        'a[aria-label*="Bekijk"]',
        '[data-testid*="play"]',
        'video',
      ];

      for (const selector of playSelectors) {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await btn.click({ force: true }).catch(() => {});
          break;
        }
      }

      const startTime = Date.now();
      while (!capturedStreamUrl && !streamErrorCode && Date.now() - startTime < 12000) {
        await page.waitForTimeout(400);
      }
    }

    if (!capturedStreamUrl) {
      if (streamErrorCode) {
        throw new Error(
          `VRT MAX videospeler weigerde de stream (code: ${streamErrorCode}). Controleer het ingestelde VRT-account.`
        );
      }
      throw new Error('Kon geen videostream (.mpd / .m3u8) vinden op deze VRT MAX pagina.');
    }

    const m3u8Url = capturedStreamUrl
      .replace(/\.mpd.*$/, '.m3u8')
      .replace(/\.m3u8\?.*$/, '.m3u8');
    console.log(`🔄 Omgezette .m3u8 stream-link: ${m3u8Url}`);

    return {
      metadata,
      mpdUrl: capturedStreamUrl,
      m3u8Url,
      drmDetected,
    };
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
}

/**
 * Zet WebVTT inhoud netjes om naar geldig SubRip (.srt) formaat.
 */
export function convertVttToSrt(vttText) {
  if (!vttText) return '';
  const cleaned = vttText
    .replace(/\r\n/g, '\n')
    .replace(/^WEBVTT[^\n]*\n+/gim, '')
    .replace(/^X-TIMESTAMP-MAP[^\n]*\n+/gim, '')
    .replace(/^STYLE[\s\S]*?\n\n/gim, '')
    .replace(/^NOTE[\s\S]*?\n\n/gim, '');

  const blocks = cleaned
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const srtBlocks = [];
  let index = 1;
  const seenCues = new Set();

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim());
    const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx === -1) continue;

    const timeLine = lines[timeLineIdx]
      .replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2')
      .replace(/\b(\d{2}:\d{2})\.(\d{3})/g, '00:$1,$2')
      .replace(/(-->\s*\d{2}:\d{2}:\d{2},\d{3}).*$/, '$1');

    const textLines = lines
      .slice(timeLineIdx + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();

    if (!textLines) continue;
    const dedupKey = `${timeLine}|${textLines}`;
    if (seenCues.has(dedupKey)) continue;
    seenCues.add(dedupKey);

    srtBlocks.push(`${index}\n${timeLine}\n${textLines}`);
    index++;
  }

  return srtBlocks.join('\n\n') + '\n';
}

/**
 * Downloadt de ondertitels van een .m3u8 link via yt-dlp of rechtstreeks uit het HLS-manifest.
 */
export async function extractSubtitlesFromM3u8(m3u8Url, outputDir, baseName) {
  await fs.mkdir(outputDir, { recursive: true });
  await fetchWithRetry(m3u8Url, {}, 4, 2000).catch(() => {});

  const outputTemplate = path.join(outputDir, `${baseName}.%(ext)s`);

  try {
    await execFileAsync('yt-dlp', [
      '--write-subs',
      '--all-subs',
      '--convert-subs',
      'srt',
      '--skip-download',
      '--no-part',
      '--retries',
      '5',
      '--fragment-retries',
      '5',
      '--concurrent-fragments',
      '10',
      '-o',
      outputTemplate,
      m3u8Url,
    ]);
  } catch (err) {
    console.warn(`⚠️ yt-dlp sub-extractie melding: ${err.message.split('\n')[0]}`);
  }

  const files = await fs.readdir(outputDir).catch(() => []);
  const srtFile = files.find((f) => f.startsWith(`${baseName}.`) && f.endsWith('.srt') && !f.includes('.part'));
  const vttFile = files.find((f) => f.startsWith(`${baseName}.`) && f.endsWith('.vtt') && !f.includes('.part'));

  if (srtFile || vttFile) {
    const chosen = srtFile || vttFile;
    const rawContent = await fs.readFile(path.join(outputDir, chosen), 'utf-8');
    if (rawContent.trim().length > 50) {
      const isVtt = rawContent.trimStart().startsWith('WEBVTT') || chosen.endsWith('.vtt');
      const srtContent = isVtt ? convertVttToSrt(rawContent) : rawContent;
      const finalSrtPath = path.join(outputDir, `${baseName}.srt`);
      await fs.writeFile(finalSrtPath, srtContent, 'utf-8');
      return { hasSubtitles: true, srtPath: finalSrtPath, srtContent };
    }
  }

  // Fallback: rechtstreeks het .m3u8 manifest uitlezen voor TYPE=SUBTITLES
  try {
    const masterRes = await fetchWithRetry(m3u8Url, {}, 5, 2000);
    if (!masterRes.ok) return { hasSubtitles: false, srtPath: null, srtContent: null };

    const masterText = await masterRes.text();
    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
    const subMatch = masterText.match(/#EXT-X-MEDIA:[^\r\n]*TYPE=SUBTITLES[^\r\n]*URI="([^"]+)"/i);
    if (!subMatch) return { hasSubtitles: false, srtPath: null, srtContent: null };

    const subPlaylistUrl = new URL(subMatch[1], baseUrl).href;
    const subPlaylistRes = await fetchWithRetry(subPlaylistUrl, {}, 4, 2000);
    const subPlaylistText = await subPlaylistRes.text();
    const subBaseUrl = subPlaylistUrl.substring(0, subPlaylistUrl.lastIndexOf('/') + 1);

    const segmentUrls = subPlaylistText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => new URL(l, subBaseUrl).href);

    const parts = [];
    const batchSize = 10;
    for (let i = 0; i < segmentUrls.length; i += batchSize) {
      const batch = segmentUrls.slice(i, i + batchSize);
      const texts = await Promise.all(
        batch.map(async (segUrl) => {
          const segRes = await fetchWithRetry(segUrl, {}, 3, 1000);
          return segRes.ok ? await segRes.text() : '';
        })
      );
      parts.push(...texts.filter(Boolean));
    }

    const combinedVtt = parts.join('\n\n');
    const srtContent = convertVttToSrt(combinedVtt);
    if (srtContent.trim().length > 20) {
      const finalSrtPath = path.join(outputDir, `${baseName}.srt`);
      await fs.writeFile(finalSrtPath, srtContent, 'utf-8');
      return { hasSubtitles: true, srtPath: finalSrtPath, srtContent };
    }
  } catch (subErr) {
    console.warn(`⚠️ Geen ondertitels gevonden via fallback: ${subErr.message}`);
  }

  return { hasSubtitles: false, srtPath: null, srtContent: null };
}

/**
 * Haalt alle beschikbare videokwaliteiten, audiostreams en ondertitels op uit de .m3u8 link.
 */
export async function inspectM3u8Qualities(m3u8Url) {
  await fetchWithRetry(m3u8Url, {}, 4, 2000).catch(() => {});

  let durationSeconds = null;
  const qualitiesMap = new Map();

  // 1. Probeer yt-dlp -J voor exacte formaten en duur
  try {
    const { stdout } = await execFileAsync(
      'yt-dlp',
      ['-J', '--no-warnings', '--retries', '4', m3u8Url],
      { maxBuffer: 25 * 1024 * 1024 }
    );
    const info = JSON.parse(stdout);
    if (info.duration) {
      durationSeconds = Math.round(info.duration);
    }

    if (Array.isArray(info.formats)) {
      for (const fmt of info.formats) {
        if (fmt.vcodec && fmt.vcodec !== 'none' && fmt.height) {
          const h = Number(fmt.height);
          const w = Number(fmt.width || Math.round((h * 16) / 9));
          const tbr = Number(fmt.tbr || fmt.vbr || 0);
          const existing = qualitiesMap.get(h);
          if (!existing || tbr > existing.tbr) {
            qualitiesMap.set(h, {
              id: `video-${h}p`,
              height: h,
              width: w,
              label:
                h >= 1080
                  ? `${h}p Full HD`
                  : h >= 720
                  ? `${h}p HD`
                  : `${h}p SD`,
              resolution: `${w}x${h}`,
              tbr: Math.round(tbr),
              formatId: fmt.format_id,
              estimatedSizeMb:
                durationSeconds && tbr
                  ? Math.round(((tbr + 128) * 1000 * durationSeconds) / 8 / (1024 * 1024))
                  : null,
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️ yt-dlp -J fallback naar directe .m3u8 parser: ${err.message.split('\n')[0]}`);
  }

  // 2. Vul aan of fallback via directe .m3u8 manifest parsing
  if (qualitiesMap.size === 0) {
    try {
      const res = await fetchWithRetry(m3u8Url, {}, 4, 2000);
      if (res.ok) {
        const text = await res.text();
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
            const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
            if (resMatch) {
              const w = Number(resMatch[1]);
              const h = Number(resMatch[2]);
              const tbr = bwMatch ? Math.round(Number(bwMatch[1]) / 1000) : 0;
              const existing = qualitiesMap.get(h);
              if (!existing || tbr > existing.tbr) {
                qualitiesMap.set(h, {
                  id: `video-${h}p`,
                  height: h,
                  width: w,
                  label:
                    h >= 1080
                      ? `${h}p Full HD`
                      : h >= 720
                      ? `${h}p HD`
                      : `${h}p SD`,
                  resolution: `${w}x${h}`,
                  tbr,
                  formatId: `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`,
                  estimatedSizeMb:
                    durationSeconds && tbr
                      ? Math.round((tbr * 1000 * durationSeconds) / 8 / (1024 * 1024))
                      : null,
                });
              }
            }
          }
        }
      }
    } catch {}
  }

  const videoQualities = Array.from(qualitiesMap.values()).sort((a, b) => b.height - a.height);

  // Standaard kwaliteiten als manifest geen resoluties prijsgeeft
  if (videoQualities.length === 0) {
    videoQualities.push(
      { id: 'video-1080p', height: 1080, width: 1920, label: '1080p Full HD (Beste)', resolution: '1920x1080', tbr: 4500, estimatedSizeMb: null },
      { id: 'video-720p', height: 720, width: 1280, label: '720p HD', resolution: '1280x720', tbr: 2500, estimatedSizeMb: null },
      { id: 'video-540p', height: 540, width: 960, label: '540p SD', resolution: '960x540', tbr: 1400, estimatedSizeMb: null },
      { id: 'video-360p', height: 360, width: 640, label: '360p Compact', resolution: '640x360', tbr: 800, estimatedSizeMb: null }
    );
  }

  // Voeg ook altijd een "Enkel Audio (.mp3 / .m4a)" optie toe
  videoQualities.push({
    id: 'audio-only',
    height: 0,
    width: 0,
    label: 'Enkel Audio (M4A)',
    resolution: 'Audio',
    tbr: 128,
    audioOnly: true,
    estimatedSizeMb: durationSeconds ? Math.max(1, Math.round((128 * 1000 * durationSeconds) / 8 / (1024 * 1024))) : null,
  });

  return {
    durationSeconds,
    qualities: videoQualities,
  };
}

/**
 * Downloadt de video (of audio) in de gekozen kwaliteit via yt-dlp.
 */
export async function downloadMediaFromM3u8({
  m3u8Url,
  qualityId,
  height,
  audioOnly = false,
  embedSubs = false,
  outputDir,
  baseName,
}) {
  await fs.mkdir(outputDir, { recursive: true });
  await fetchWithRetry(m3u8Url, {}, 4, 2000).catch(() => {});

  const ext = audioOnly ? 'm4a' : 'mp4';
  const finalFilePath = path.join(outputDir, `${baseName}.${ext}`);
  const outputTemplate = path.join(outputDir, `${baseName}.%(ext)s`);

  const args = [
    '--no-part',
    '--retries',
    '10',
    '--fragment-retries',
    '10',
    '--concurrent-fragments',
    '10',
  ];

  if (audioOnly || qualityId === 'audio-only') {
    args.push('-f', 'bestaudio/best', '-x', '--audio-format', 'm4a');
  } else {
    const targetHeight = Number(height) || 1080;
    args.push(
      '-f',
      `bestvideo[height<=${targetHeight}]+bestaudio/best[height<=${targetHeight}]/best`,
      '--merge-output-format',
      'mp4'
    );
    if (embedSubs) {
      args.push('--embed-subs', '--sub-langs', 'all');
    }
  }

  args.push('-o', outputTemplate, m3u8Url);

  console.log(`🎬 Starten van yt-dlp download: yt-dlp ${args.join(' ')}`);
  const { stdout, stderr } = await execFileAsync('yt-dlp', args, {
    maxBuffer: 50 * 1024 * 1024,
  });
  if (stdout) console.log(stdout.slice(-1000));
  if (stderr) console.warn(stderr.slice(-1000));

  const files = await fs.readdir(outputDir);
  const downloaded = files.find(
    (f) =>
      f.startsWith(`${baseName}.`) &&
      (f.endsWith('.mp4') || f.endsWith('.m4a') || f.endsWith('.mkv') || f.endsWith('.webm')) &&
      !f.includes('.part')
  );

  if (!downloaded) {
    throw new Error('Download voltooid, maar het uitvoerbestand werd niet gevonden op schijf.');
  }

  const fullPath = path.join(outputDir, downloaded);
  const stat = await fs.stat(fullPath);

  return {
    filePath: fullPath,
    fileName: downloaded,
    sizeBytes: stat.size,
  };
}

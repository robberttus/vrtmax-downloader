import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const ROOT_DIR = process.cwd();
export const AUTH_TOKEN_CACHE_PATH = path.join(ROOT_DIR, '.auth', 'vrt-token.json');
const DEFAULT_GIGYA_API_KEY = '3_qhEcPa5JGFROVwu5SWKqJ4mVOIkwlFNMSKwzPDAh8QZOtHqu6L4nD5Q7lk0eXOOG';

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
export async function fetchWithRetry(url, options = {}, retries = 4, delayMs = 1500) {
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
    } catch (err) {
      lastErr = err;
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }

  if (lastRes) return lastRes;
  throw lastErr || new Error(`Kon ${url} niet ophalen na ${retries} pogingen.`);
}

/**
 * Haalt alle Set-Cookie headers op als array uit een fetch Response.
 */
function getSetCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') {
    return res.headers.getSetCookie();
  }
  const raw = res.headers.get('set-cookie');
  return raw ? [raw] : [];
}

/**
 * Zoekt een specifieke cookie-waarde in een lijst van Set-Cookie strings.
 */
function extractCookieValue(setCookieArray, cookieName) {
  for (const line of setCookieArray) {
    const match = line.match(new RegExp(`^\\s*${cookieName}=([^;]+)`));
    if (match && match[1] && match[1] !== 'deleted') {
      return match[1];
    }
  }
  return null;
}

/**
 * Razendsnelle browserloze HTTP-login op VRT MAX (duurt < 1 seconde, geen Chromium nodig!).
 * Retourneert de geldige `vrtnu-site_profile_vt` (identityToken).
 */
export async function getVrtVideoToken({ email, password }) {
  // 1. Controleer of er nog een geldige gecachete token op schijf staat
  try {
    const raw = await fs.readFile(AUTH_TOKEN_CACHE_PATH, 'utf-8');
    const cached = JSON.parse(raw);
    if (cached.identityToken && cached.expiresAt && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
      console.log('✅ Geldige VRT MAX sessie-token gevonden in cache!');
      return cached.identityToken;
    }
  } catch {}

  if (!email || !password) {
    throw new Error('Geen VRT_EMAIL en VRT_PASSWORD ingesteld in GitHub Secrets!');
  }

  console.log('🔐 Inloggen op VRT MAX via directe HTTP SSO (<1s)...');

  // Stap 1: Start OIDC flow op vrt.be om oidcstate cookie + authorize URL te krijgen
  const step1Res = await fetch(
    'https://www.vrt.be/vrtmax/sso/login?resumePage=https%3A%2F%2Fwww.vrt.be%2Fvrtmax%2F',
    { redirect: 'manual' }
  );
  const step1Cookies = getSetCookies(step1Res);
  const oidcState = extractCookieValue(step1Cookies, 'oidcstate');
  const authorizeUrl = step1Res.headers.get('location');

  if (!oidcState || !authorizeUrl) {
    throw new Error('Kon VRT SSO login-sessie (oidcstate) niet starten.');
  }

  // Stap 2: Open authorizeUrl op login.vrt.be om OIDCXSRF en SESSION cookies op te halen
  const step2Res = await fetch(authorizeUrl, { redirect: 'manual' });
  const step2Cookies = getSetCookies(step2Res);
  const xsrf = extractCookieValue(step2Cookies, 'OIDCXSRF');
  const sessionCookie = extractCookieValue(step2Cookies, 'SESSION');

  if (!xsrf) {
    throw new Error('Kon OIDCXSRF token niet ophalen van login.vrt.be.');
  }

  // Stap 3: Authenticeer e-mail en wachtwoord bij Gigya (VRT profiel)
  const gigyaParams = new URLSearchParams({
    loginID: email,
    password: password,
    APIKey: DEFAULT_GIGYA_API_KEY,
    format: 'json',
  });

  const gigyaRes = await fetch('https://accounts.eu1.gigya.com/accounts.login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: gigyaParams.toString(),
  });
  const gigyaData = await gigyaRes.json();

  if (gigyaData.errorCode !== 0 || !gigyaData.UID) {
    throw new Error(
      `VRT login geweigerd (${gigyaData.errorDetails || gigyaData.errorMessage || 'Controleer VRT_EMAIL en VRT_PASSWORD'}).`
    );
  }

  // Stap 4: Wissel Gigya handtekening in bij login.vrt.be/perform_login
  const loginCookies = [`OIDCXSRF=${xsrf}`];
  if (sessionCookie) loginCookies.push(`SESSION=${sessionCookie}`);

  const performParams = new URLSearchParams({
    UID: gigyaData.UID,
    UIDSignature: gigyaData.UIDSignature,
    signatureTimestamp: String(gigyaData.signatureTimestamp),
    client_id: 'vrtnu-site',
    _csrf: xsrf,
  });

  const step4Res = await fetch('https://login.vrt.be/perform_login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: loginCookies.join('; '),
    },
    body: performParams.toString(),
    redirect: 'manual',
  });

  const step4Cookies = getSetCookies(step4Res);
  const newSession = extractCookieValue(step4Cookies, 'SESSION') || sessionCookie;
  const authRedirectUrl = step4Res.headers.get('location');

  if (!authRedirectUrl) {
    throw new Error('Geen redirect ontvangen na login.vrt.be/perform_login.');
  }

  // Stap 5: Volg de authorize redirect op login.vrt.be om de callback URL te krijgen
  const step5Cookies = [`OIDCXSRF=${xsrf}`];
  if (newSession) step5Cookies.push(`SESSION=${newSession}`);

  const step5Res = await fetch(authRedirectUrl, {
    headers: { Cookie: step5Cookies.join('; ') },
    redirect: 'manual',
  });

  const callbackUrl = step5Res.headers.get('location');
  if (!callbackUrl) {
    throw new Error('Geen SSO callback URL ontvangen van login.vrt.be.');
  }

  // Stap 6: Roep de callback aan op www.vrt.be met de oidcstate cookie -> ontvang vrtnu-site_profile_vt
  const step6Res = await fetch(callbackUrl, {
    headers: { Cookie: `oidcstate=${oidcState}` },
    redirect: 'manual',
  });

  const step6Cookies = getSetCookies(step6Res);
  const identityToken = extractCookieValue(step6Cookies, 'vrtnu-site_profile_vt');

  if (!identityToken) {
    throw new Error('Kon vrtnu-site_profile_vt cookie niet ophalen uit VRT SSO callback.');
  }

  // Sla token voor 50 minuten op in .auth/vrt-token.json
  await fs.mkdir(path.dirname(AUTH_TOKEN_CACHE_PATH), { recursive: true });
  await fs.writeFile(
    AUTH_TOKEN_CACHE_PATH,
    JSON.stringify({
      identityToken,
      expiresAt: Date.now() + 50 * 60 * 1000,
    }),
    'utf-8'
  );

  console.log('✅ Succesvol ingelogd op VRT MAX via directe HTTP SSO!');
  return identityToken;
}

/**
 * Haalt metadata én streamId (publicationId$videoId) op voor gelijk welke VRT MAX pagina via GraphQL.
 */
export async function fetchEpisodeGraphqlInfo(vrtUrl) {
  const urlObj = new URL(vrtUrl);
  let pagePath = urlObj.pathname;
  if (!pagePath.endsWith('/')) pagePath += '/';

  const gqlQuery = `
    query {
      page(id: "${pagePath}") {
        __typename
        ... on EpisodePage {
          title
          permalink
          ldjson
          player {
            modes {
              ... on VideoPlayerMode {
                streamId
                durationInSeconds
              }
            }
          }
        }
      }
    }
  `;

  const res = await fetch('https://www.vrt.be/vrtnu-api/graphql/public/v1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-vrt-client-name': 'WEB',
    },
    body: JSON.stringify({ query: gqlQuery }),
  });

  if (!res.ok) {
    throw new Error(`VRT MAX GraphQL API gaf status ${res.status}.`);
  }

  const data = await res.json();
  const page = data?.data?.page;

  if (!page) {
    throw new Error('Deze VRT MAX pagina werd niet gevonden. Controleer of je een geldige afleveringslink hebt geplakt.');
  }

  let title = page.title || 'VRT MAX Aflevering';
  let programTitle = '';
  let season = null;
  let episodeNumber = null;
  let description = '';
  let broadcastDate = null;
  let thumbnailUrl = null;
  let publicationId = null;
  let videoId = null;

  if (Array.isArray(page.ldjson)) {
    for (const raw of page.ldjson) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed['@type'] === 'TVEpisode' || parsed.video || parsed.publication) {
          title = parsed.name || title;
          programTitle = parsed.partOfSeries?.name || programTitle;
          season = parsed.partOfSeason?.name || parsed.partOfSeason?.seasonNumber || season;
          episodeNumber = parsed.episodeNumber || episodeNumber;
          description = (parsed.description || '').replace(/<[^>]+>/g, '').trim() || description;
          broadcastDate = parsed.publication?.[0]?.startDate || parsed.video?.uploadDate || broadcastDate;
          thumbnailUrl =
            (Array.isArray(parsed.video?.thumbnailUrl) ? parsed.video.thumbnailUrl[0] : parsed.video?.thumbnailUrl) ||
            (Array.isArray(parsed.thumbnailUrl) ? parsed.thumbnailUrl[0] : parsed.thumbnailUrl) ||
            thumbnailUrl;
          if (parsed.publication?.[0]?.['@id']) publicationId = parsed.publication[0]['@id'];
          if (parsed.video?.['@id']) videoId = parsed.video['@id'];
        }
      } catch {}
    }
  }

  const mode = (page.player?.modes || []).find((m) => m.streamId);
  const streamId = mode?.streamId || (publicationId && videoId ? `${publicationId}$${videoId}` : videoId);
  const durationSeconds = mode?.durationInSeconds || null;

  if (!streamId) {
    throw new Error(
      'Kon geen afleverings-stream vinden op deze link. Plak de link van een specifieke aflevering op VRT MAX.'
    );
  }

  return {
    streamId,
    metadata: {
      url: vrtUrl,
      title,
      programTitle,
      season,
      episodeNumber,
      description,
      broadcastDate,
      durationSeconds,
      thumbnailUrl,
    },
  };
}

/**
 * Probeert de streamId en identityToken om te zetten naar een .m3u8 link.
 * Let op: voor programma's met een Belgisch geoblock kan VRT dit op een Amerikaanse GitHub Actions server
 * weigeren; in dat geval lost de browser van de bezoeker (in België) de .m3u8 link zelf op in 0.3s!
 */
export async function tryResolveStreamOnServer(streamId, identityToken) {
  try {
    const tokenRes = await fetch(
      'https://media-services-public.vrt.be/vualto-video-aggregator-web/rest/external/v2/tokens',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken }),
      }
    );
    if (!tokenRes.ok) return { resolved: false, reason: `token_status_${tokenRes.status}` };
    const tokenData = await tokenRes.json();
    if (!tokenData.vrtPlayerToken) return { resolved: false, reason: 'no_player_token' };

    const mediaUrl = `https://media-services-public.vrt.be/media-aggregator/v2/media-items/${encodeURIComponent(
      streamId
    )}?client=vrtnu-web%40PROD&vrtPlayerToken=${encodeURIComponent(tokenData.vrtPlayerToken)}`;

    const mediaRes = await fetch(mediaUrl);
    const mediaData = await mediaRes.json().catch(() => ({}));

    if (!mediaRes.ok || !Array.isArray(mediaData.targetUrls)) {
      console.log(
        `ℹ️ Server-side stream-aanvraag gaf code "${mediaData.code || mediaRes.status}" (waarschijnlijk Belgische IP-check). Browser in België handelt dit direct af!`
      );
      return {
        resolved: false,
        reason: mediaData.code || `http_${mediaRes.status}`,
      };
    }

    const hls = mediaData.targetUrls.find((t) => t.type === 'hls' || t.url?.includes('.m3u8'));
    const dash = mediaData.targetUrls.find((t) => t.type === 'mpeg_dash' || t.url?.includes('.mpd'));
    const chosen = hls || dash || mediaData.targetUrls[0];

    if (!chosen?.url) {
      return { resolved: false, reason: 'no_target_url' };
    }

    const m3u8Url = chosen.url.replace(/\.mpd.*$/, '.m3u8').replace(/\.m3u8\?.*$/, '.m3u8');
    return {
      resolved: true,
      mpdUrl: chosen.url,
      m3u8Url,
      drmDetected: Boolean(mediaData.drm),
    };
  } catch (err) {
    return { resolved: false, reason: err.message };
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
  await fetchWithRetry(m3u8Url, {}, 4, 1500).catch(() => {});

  try {
    const masterRes = await fetchWithRetry(m3u8Url, {}, 4, 1500);
    if (masterRes.ok) {
      const masterText = await masterRes.text();
      const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
      const subMatch = masterText.match(/#EXT-X-MEDIA:[^\r\n]*TYPE=SUBTITLES[^\r\n]*URI="([^"]+)"/i);
      if (subMatch) {
        const subPlaylistUrl = new URL(subMatch[1], baseUrl).href;
        const subPlaylistRes = await fetchWithRetry(subPlaylistUrl, {}, 4, 1500);
        const subPlaylistText = await subPlaylistRes.text();
        const subBaseUrl = subPlaylistUrl.substring(0, subPlaylistUrl.lastIndexOf('/') + 1);

        const segmentUrls = subPlaylistText
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))
          .map((l) => new URL(l, subBaseUrl).href);

        const parts = [];
        const batchSize = 15;
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
      }
    }
  } catch (subErr) {
    console.warn(`⚠️ Directe ondertitel-extractie melding: ${subErr.message}`);
  }

  return { hasSubtitles: false, srtPath: null, srtContent: null };
}

/**
 * Haalt alle beschikbare videokwaliteiten en audiostreams op uit de .m3u8 link.
 */
export async function inspectM3u8Qualities(m3u8Url, fallbackDuration = null) {
  let durationSeconds = fallbackDuration;
  const qualitiesMap = new Map();

  try {
    const res = await fetchWithRetry(m3u8Url, {}, 4, 1500);
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
                label: h >= 1080 ? `${h}p Full HD` : h >= 720 ? `${h}p HD` : `${h}p SD`,
                resolution: `${w}x${h}`,
                tbr,
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

  const videoQualities = Array.from(qualitiesMap.values()).sort((a, b) => b.height - a.height);

  if (videoQualities.length === 0) {
    videoQualities.push(
      { id: 'video-1080p', height: 1080, width: 1920, label: '1080p Full HD (Beste)', resolution: '1920x1080', tbr: 4500, estimatedSizeMb: null },
      { id: 'video-720p', height: 720, width: 1280, label: '720p HD', resolution: '1280x720', tbr: 2500, estimatedSizeMb: null },
      { id: 'video-540p', height: 540, width: 960, label: '540p SD', resolution: '960x540', tbr: 1400, estimatedSizeMb: null },
      { id: 'video-360p', height: 360, width: 640, label: '360p Compact', resolution: '640x360', tbr: 800, estimatedSizeMb: null }
    );
  }

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
  await fetchWithRetry(m3u8Url, {}, 4, 1500).catch(() => {});

  // Controleer vooraf in het .m3u8 manifest of de videosegmenten DRM-versleuteld zijn
  const masterRes = await fetchWithRetry(m3u8Url, {}, 3, 1500).catch(() => null);
  if (masterRes?.ok) {
    const masterText = await masterRes.text();
    if (masterText.includes('METHOD=SAMPLE-AES') || masterText.includes('fairplay-license')) {
      throw new Error(
        'Dit specifieke programma heeft FairPlay/Widevine DRM-kopieerbeveiliging op de videostream bij VRT MAX. De Nederlandse ondertitels (.srt / .vtt) zijn wél vrij te downloaden!'
      );
    }
  }

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

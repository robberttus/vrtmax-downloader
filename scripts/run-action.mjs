import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getVrtVideoToken,
  fetchEpisodeGraphqlInfo,
  tryResolveStreamOnServer,
  inspectM3u8Qualities,
  extractSubtitlesFromM3u8,
  downloadMediaFromM3u8,
  sanitizeFilename,
} from './vrt-core.mjs';

const OUTPUT_DIR = path.join(process.cwd(), 'output');

function getArgOrEnv(argName, envName, defaultValue = '') {
  const prefix = `--${argName}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  return process.env[envName] ?? defaultValue;
}

async function writeJobResult(jobId, payload) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const jobFile = path.join(OUTPUT_DIR, `job-${jobId}.json`);
  await fs.writeFile(
    jobFile,
    JSON.stringify(
      {
        jobId,
        updatedAt: new Date().toISOString(),
        ...payload,
      },
      null,
      2
    ),
    'utf-8'
  );
  console.log(`📄 Job-resultaat opgeslagen in: ${jobFile}`);
}

async function main() {
  const mode = getArgOrEnv('mode', 'ACTION_MODE', 'inspect');
  const jobId = getArgOrEnv('job-id', 'JOB_ID', `local-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '');
  const vrtUrl = getArgOrEnv('url', 'VRT_URL', '').trim();
  const providedM3u8 = getArgOrEnv('m3u8', 'M3U8_URL', '').trim();
  const qualityId = getArgOrEnv('quality', 'QUALITY_ID', 'video-1080p').trim();
  const height = Number(getArgOrEnv('height', 'VIDEO_HEIGHT', '1080')) || 1080;
  const audioOnly = getArgOrEnv('audio-only', 'AUDIO_ONLY', 'false') === 'true' || qualityId === 'audio-only';
  const embedSubs = getArgOrEnv('embed-subs', 'EMBED_SUBS', 'false') === 'true';
  const providedTitle = getArgOrEnv('title', 'EPISODE_TITLE', '').trim();

  const email = process.env.VRT_EMAIL?.trim();
  const password = process.env.VRT_PASSWORD?.trim();

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  console.log('====================================================');
  console.log(`🎬 VRT MAX DOWNLOADER ACTIE (${mode.toUpperCase()})`);
  console.log(`   Job ID:  ${jobId}`);
  console.log(`   VRT URL: ${vrtUrl || '(via bestaande m3u8)'}`);
  console.log('====================================================');

  try {
    if (mode === 'inspect') {
      if (!vrtUrl || !vrtUrl.includes('vrt.be/vrtmax')) {
        throw new Error('Geef een geldige VRT MAX link op (bijv. https://www.vrt.be/vrtmax/a-z/...).');
      }

      // Haal VRT MAX login-token én pagina-metadata tegelijk op (< 1 seconde!)
      const [identityToken, gqlInfo] = await Promise.all([
        getVrtVideoToken({ email, password }),
        fetchEpisodeGraphqlInfo(vrtUrl),
      ]);

      const safeTitle = sanitizeFilename(
        gqlInfo.metadata.programTitle
          ? `${gqlInfo.metadata.programTitle} - ${gqlInfo.metadata.title}`
          : gqlInfo.metadata.title
      );

      // Probeer de stream alvast op de server op te lossen (werkt voor wereldwijde VRT-programma's zoals Thuis)
      const serverStream = await tryResolveStreamOnServer(gqlInfo.streamId, identityToken);

      if (serverStream.resolved && serverStream.m3u8Url) {
        console.log('🔍 Stream op server gevonden, kwaliteiten en ondertitels uitlezen...');
        const [qualityInfo, subInfo] = await Promise.all([
          inspectM3u8Qualities(serverStream.m3u8Url, gqlInfo.metadata.durationSeconds),
          extractSubtitlesFromM3u8(serverStream.m3u8Url, OUTPUT_DIR, `${jobId}-${safeTitle}`),
        ]);

        await writeJobResult(jobId, {
          status: 'READY',
          mode: 'inspect',
          streamId: gqlInfo.streamId,
          identityToken,
          metadata: {
            ...gqlInfo.metadata,
            durationSeconds: qualityInfo.durationSeconds || gqlInfo.metadata.durationSeconds,
            safeFilename: safeTitle,
          },
          m3u8Url: serverStream.m3u8Url,
          mpdUrl: serverStream.mpdUrl,
          drmDetected: serverStream.drmDetected,
          qualities: qualityInfo.qualities,
          subtitles: {
            available: subInfo.hasSubtitles,
            languages: subInfo.hasSubtitles ? [{ code: 'nl', label: 'Nederlands (.srt & .vtt)' }] : [],
            srtContent: subInfo.srtContent || null,
          },
        });
      } else {
        // Voor programma's met Belgisch geoblock (zoals F*ck you, flik) geven we streamId + identityToken
        // terug zodat de browser van de bezoeker (met Belgisch IP!) de .m3u8 en ondertitels zelf ophaalt in 0.5s!
        await writeJobResult(jobId, {
          status: 'READY',
          mode: 'inspect',
          needsClientStreamResolve: true,
          streamId: gqlInfo.streamId,
          identityToken,
          metadata: {
            ...gqlInfo.metadata,
            safeFilename: safeTitle,
          },
          m3u8Url: null,
          qualities: [],
          subtitles: {
            available: false,
            languages: [],
            srtContent: null,
          },
        });
      }

      console.log('✅ Inladen van VRT MAX gegevens voltooid!');
      return;
    }

    if (mode === 'download') {
      let m3u8Url = providedM3u8;
      let episodeTitle = providedTitle || 'VRT_MAX_Aflevering';

      if (!m3u8Url) {
        if (!vrtUrl) {
          throw new Error('Geen M3U8_URL of VRT_URL opgegeven voor download.');
        }
        const [identityToken, gqlInfo] = await Promise.all([
          getVrtVideoToken({ email, password }),
          fetchEpisodeGraphqlInfo(vrtUrl),
        ]);
        const serverStream = await tryResolveStreamOnServer(gqlInfo.streamId, identityToken);
        if (!serverStream.resolved || !serverStream.m3u8Url) {
          throw new Error('Kon de .m3u8 stream niet op de server openen.');
        }
        m3u8Url = serverStream.m3u8Url;
        episodeTitle = gqlInfo.metadata.title || episodeTitle;
      }

      const safeBaseName = `${jobId}-${sanitizeFilename(episodeTitle)}`;

      const downloaded = await downloadMediaFromM3u8({
        m3u8Url,
        qualityId,
        height,
        audioOnly,
        embedSubs,
        outputDir: OUTPUT_DIR,
        baseName: safeBaseName,
      });

      await writeJobResult(jobId, {
        status: 'READY',
        mode: 'download',
        fileName: downloaded.fileName,
        sizeBytes: downloaded.sizeBytes,
        qualityId,
        height,
        audioOnly,
        embedSubs,
      });

      console.log(`✅ Download klaar: ${downloaded.fileName} (${Math.round(downloaded.sizeBytes / 1024 / 1024)} MB)`);
      return;
    }

    throw new Error(`Onbekende modus: ${mode}`);
  } catch (err) {
    console.error(`❌ Fout tijdens uitvoeren van job ${jobId}:`, err.message);
    await writeJobResult(jobId, {
      status: 'ERROR',
      mode,
      error: err.message || 'Er is een onbekende fout opgetreden.',
    });
    process.exit(1);
  }
}

main();

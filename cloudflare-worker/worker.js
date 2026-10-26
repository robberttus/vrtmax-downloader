/**
 * GRATIS CLOUDFLARE WORKER VOOR VRT MAX DOWNLOADER (OP GITHUB PAGES)
 *
 * Waarom dit bestand?
 * GitHub Pages is een puur statische website. Als je je GitHub Token in de frontend-code
 * zou zetten, trekt GitHub die token binnen 5 seconden in omdat die publiek zichtbaar is.
 * Deze Cloudflare Worker (100% gratis tot 100.000 verzoeken per dag) bewaart je GITHUB_TOKEN
 * veilig op de achtergrond en laat bezoekers op je website zonder inloggen op "Inladen" en "Download" klikken.
 *
 * Instellen in Cloudflare (duurt 2 minuten):
 * 1. Ga naar https://dash.cloudflare.com -> Workers & Pages -> Create Worker
 * 2. Plak de inhoud van dit bestand in de editor en klik op Deploy.
 * 3. Ga in je Worker naar Settings -> Variables and Secrets en voeg toe:
 *    - GITHUB_OWNER : jouw GitHub gebruikersnaam (bijv. "robbesonck")
 *    - GITHUB_REPO  : de naam van je repository (bijv. "vrtmax-downloader")
 *    - GITHUB_TOKEN : jouw GitHub Personal Access Token (met repo / workflow rechten)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'vrtmax-downloader-worker',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const owner = env.GITHUB_OWNER || 'robberttus';
    const repo = env.GITHUB_REPO || 'vrtmax-downloader';
    const token = env.GITHUB_TOKEN;

    if (!token) {
      return jsonResponse(
        {
          error:
            'Cloudflare Worker mist nog GITHUB_TOKEN. Voeg GITHUB_TOKEN toe bij Settings -> Variables and Secrets in Cloudflare.',
        },
        500
      );
    }

    const url = new URL(request.url);

    try {
      // 1. STAP "INLADEN": Start GitHub Action in 'inspect' modus
      if (request.method === 'POST' && url.pathname === '/api/inspect') {
        const body = await request.json();
        const vrtUrl = (body.url || '').trim();

        if (!vrtUrl || !vrtUrl.includes('vrt.be/vrtmax')) {
          return jsonResponse(
            { error: 'Plak een geldige VRT MAX link (bijv. https://www.vrt.be/vrtmax/a-z/...).' },
            400
          );
        }

        const jobId = `insp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        const dispatchRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/actions/workflows/vrt-downloader.yml/dispatches`,
          {
            method: 'POST',
            headers: {
              ...githubHeaders(token),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              ref: env.GITHUB_BRANCH || 'main',
              inputs: {
                mode: 'inspect',
                job_id: jobId,
                vrt_url: vrtUrl,
              },
            }),
          }
        );

        if (!dispatchRes.ok) {
          const errText = await dispatchRes.text();
          return jsonResponse(
            { error: `Kon GitHub Action niet starten (${dispatchRes.status}): ${errText}` },
            502
          );
        }

        return jsonResponse({
          ok: true,
          jobId,
          status: 'QUEUED',
          message: 'VRT MAX aflevering wordt ingeladen via GitHub Actions...',
        });
      }

      // 2. STAP "DOWNLOAD": Start GitHub Action in 'download' modus voor de gekozen kwaliteit
      if (request.method === 'POST' && url.pathname === '/api/download') {
        const body = await request.json();
        const jobId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        const dispatchRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/actions/workflows/vrt-downloader.yml/dispatches`,
          {
            method: 'POST',
            headers: {
              ...githubHeaders(token),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              ref: env.GITHUB_BRANCH || 'main',
              inputs: {
                mode: 'download',
                job_id: jobId,
                vrt_url: (body.vrtUrl || '').trim(),
                m3u8_url: (body.m3u8Url || '').trim(),
                quality_id: String(body.qualityId || 'video-1080p'),
                video_height: String(body.height || '1080'),
                audio_only: body.audioOnly ? 'true' : 'false',
                embed_subs: body.embedSubs ? 'true' : 'false',
                episode_title: String(body.title || 'VRT_MAX_Aflevering').slice(0, 80),
              },
            }),
          }
        );

        if (!dispatchRes.ok) {
          const errText = await dispatchRes.text();
          return jsonResponse(
            { error: `Kon download-workflow niet starten (${dispatchRes.status}): ${errText}` },
            502
          );
        }

        return jsonResponse({
          ok: true,
          jobId,
          status: 'QUEUED',
          message: 'Download van video gestart op GitHub Actions...',
        });
      }

      // 3. STATUS POLLEN: Kijk of job-<jobId>.json al klaarstaat in de 'downloads-cache' release
      if (request.method === 'GET' && url.pathname === '/api/status') {
        const jobId = (url.searchParams.get('jobId') || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!jobId) {
          return jsonResponse({ error: 'Geen geldig jobId opgegeven.' }, 400);
        }

        const relRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/releases/tags/downloads-cache`,
          { headers: githubHeaders(token) }
        );

        if (relRes.ok) {
          const release = await relRes.json();
          const targetJsonName = `job-${jobId}.json`;
          const jsonAsset = (release.assets || []).find((a) => a.name === targetJsonName);

          if (jsonAsset) {
            // Haal de inhoud van job-<jobId>.json op
            const assetRes = await fetch(jsonAsset.url, {
              headers: {
                ...githubHeaders(token),
                Accept: 'application/octet-stream',
              },
            });

            if (assetRes.ok) {
              const jobData = await assetRes.json();
              if (jobData.fileName) {
                const mediaAsset = (release.assets || []).find((a) => a.name === jobData.fileName);
                jobData.downloadUrl =
                  mediaAsset?.browser_download_url ||
                  `https://github.com/${owner}/${repo}/releases/download/downloads-cache/${encodeURIComponent(
                    jobData.fileName
                  )}`;
              }
              return jsonResponse(jobData);
            }
          }
        }

        // Als job-<jobId>.json nog niet bestaat, geef de live status van de lopende GitHub Action terug
        const runsRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/actions/workflows/vrt-downloader.yml/runs?per_page=5`,
          { headers: githubHeaders(token) }
        );

        let workflowState = 'PROCESSING';
        let activeStep = null;

        if (runsRes.ok) {
          const runsData = await runsRes.json();
          const activeRun = (runsData.workflow_runs || []).find(
            (r) => r.status === 'in_progress' || r.status === 'queued' || r.status === 'waiting'
          );
          if (activeRun) {
            workflowState = activeRun.status.toUpperCase();
          }
        }

        return jsonResponse({
          jobId,
          status: workflowState,
          activeStep,
        });
      }

      return jsonResponse({
        service: 'VRT MAX Downloader Bridge',
        status: 'online',
      });
    } catch (err) {
      return jsonResponse({ error: err.message || 'Interne fout in Worker' }, 500);
    }
  },
};

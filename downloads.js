import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_SIZE_GB = 10;
const QUALITIES = new Set(['best', '1080', '720', '480']);
const ACTIVE = new Set(['checking', 'downloading', 'converting', 'saving']);
const FINISHED = new Set(['done', 'error', 'cancelled', 'interrupted']);

export function youtubeVideoUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  try {
    const url = new URL(input.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    let videoId;
    if (host === 'youtu.be') videoId = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'www.youtube-nocookie.com'].includes(host)) {
      videoId = url.pathname === '/watch' ? url.searchParams.get('v')
        : /^\/(shorts|live|embed)\/([\w-]{11})\/?$/.exec(url.pathname)?.[2];
    }
    if (!/^[\w-]{11}$/.test(videoId || '')) return null;
    return `https://www.youtube.com/watch?v=${videoId}`;
  } catch { return null; }
}

function toolError(error, binary) {
  if (error.code === 'ENOENT') return new Error(`No se encontró ${binary} en la máquina de la API. Configura YTDLP_PATH o FFMPEG_PATH.`);
  return error;
}

async function runTool(binary, args, job, { spawnProcess = spawn, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binary, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    job.child = child;
    let output = '';
    let tail = '';
    let pending = '';
    let exceeded = false;
    const acceptLine = (line) => {
      const clean = line.trim();
      if (!clean) return;
      const progress = /(?:download:)?\s*(\d{1,3}(?:\.\d+)?)%/.exec(clean);
      if (progress) job.progress = Math.min(99, Math.max(0, Number(progress[1])));
      if (!capture && !clean.startsWith('download:')) job.logs = [...job.logs, clean.slice(0, 300)].slice(-25);
      tail = clean.slice(0, 400);
    };
    const readChunk = (chunk, isStdout) => {
      const value = chunk.toString('utf8');
      if (isStdout && capture) {
        output += value;
        if (output.length > MAX_OUTPUT) { exceeded = true; child.kill(); }
      } else {
        pending += value;
        const lines = pending.split(/\r|\n/);
        pending = lines.pop() || '';
        lines.forEach(acceptLine);
        if (pending.length > 1000) { acceptLine(pending); pending = ''; }
      }
    };
    child.stdout?.on('data', (chunk) => readChunk(chunk, true));
    child.stderr?.on('data', (chunk) => readChunk(chunk, false));
    child.once('error', (error) => { job.child = null; reject(toolError(error, binary)); });
    child.once('close', (code) => {
      job.child = null;
      if (pending) acceptLine(pending);
      if (job.cancelled) reject(new Error('Descarga cancelada'));
      else if (exceeded) reject(new Error('La respuesta de yt-dlp es demasiado grande'));
      else if (code !== 0) reject(new Error(tail || `${binary} terminó con código ${code}`));
      else resolve(output);
    });
  });
}

function selectFormat(quality, dimension, compatible) {
  const limit = quality === 'best' ? '' : `[${dimension}<=?${quality}]`;
  return compatible
    ? `bv[vcodec^=avc][ext=mp4]${limit}+ba[ext=m4a]/b[ext=mp4]${limit}`
    : `bv${limit}+ba/b${limit}`;
}

function alreadySaved(items, url) {
  return items.find((entry) => youtubeVideoUrl(entry.sourceUrl) === url);
}

export function createDownloadManager({ audioDir, videosDir, readManifest, writeManifest, readVideos, writeVideos,
  serializeMutation, jobsPath, spawnProcess = spawn, ytDlpPath = process.env.YTDLP_PATH || 'yt-dlp',
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg' }) {
  const jobs = new Map();
  let pendingWrite = Promise.resolve();
  let execution = Promise.resolve();
  let starting = false;
  const publicJob = (job) => {
    const { child, cancelled, ...visible } = job;
    return visible;
  };
  const list = () => [...jobs.values()].reverse().map(publicJob);
  const get = (id) => jobs.has(id) ? publicJob(jobs.get(id)) : null;
  const persist = () => {
    if (!jobsPath) return Promise.resolve();
    const snapshot = `${JSON.stringify(list(), null, 2)}\n`;
    pendingWrite = pendingWrite.catch(() => {}).then(async () => {
      const temporary = `${jobsPath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, snapshot);
      await fs.rename(temporary, jobsPath);
    });
    return pendingWrite;
  };
  const saveLater = () => { void persist().catch((error) => console.error('No se pudo guardar la tarea de descarga:', error)); };

  async function restore() {
    if (!jobsPath) return;
    let stored;
    try { stored = JSON.parse(await fs.readFile(jobsPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!Array.isArray(stored)) throw new Error('El historial de descargas no es válido');
    for (const entry of stored.slice(0, 50).reverse()) {
      if (!entry || typeof entry.id !== 'string' || !youtubeVideoUrl(entry.url) || !['audio', 'video'].includes(entry.mode)) continue;
      const state = ACTIVE.has(entry.state) ? 'interrupted' : entry.state;
      if (!FINISHED.has(state)) continue;
      jobs.set(entry.id, { ...entry, state, error: state === 'interrupted' ? 'La API se reinició durante la descarga. Puedes reintentarlo.' : entry.error,
        child: null, cancelled: false });
    }
    await persist();
  }

  async function execute(job) {
    let tempDir;
    try {
      const common = ['--ignore-config', '--no-playlist', '--no-exec', '--no-warnings'];
      const run = (args, capture = false) => runTool(ytDlpPath, [...common, ...args], job, { spawnProcess, capture });
      const raw = await run(['--dump-single-json', '--skip-download', job.url], true);
      if (job.cancelled) throw new Error('Descarga cancelada');
      const info = JSON.parse(raw);
      job.title = String(info.title || 'Vídeo de YouTube').slice(0, 200);
      job.duration = Number.isFinite(info.duration) ? info.duration : 0;
      job.isShort = job.isShort || (Number(info.width) > 0 && Number(info.height) > Number(info.width));
      saveLater();
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rotvault-download-'));
      const output = path.join(tempDir, `${job.id}.%(ext)s`);
      const args = ['--newline', '--max-filesize', `${job.maxSizeGb}G`,
        '--progress-template', 'download:%(progress._percent_str)s'];
      // An executable name is resolved by yt-dlp from PATH. --ffmpeg-location needs an actual path.
      if (path.isAbsolute(ffmpegPath)) args.push('--ffmpeg-location', ffmpegPath);
      args.push('-o', output);
      if (job.mode === 'audio') args.push('-f', 'ba/b', '-x', '--audio-format', 'wav');
      else args.push('-f', selectFormat(job.quality, job.isShort ? 'width' : 'height', true), '--merge-output-format', 'mp4');
      job.state = 'downloading';
      saveLater();
      try { await run([...args, job.url]); }
      catch (error) {
        if (job.cancelled || job.mode !== 'video' || !/requested format is not available/i.test(error.message)) throw error;
        job.logs = [...job.logs, 'No hay MP4 compatible en esa calidad. Probando otros formatos y conversión a MP4.'].slice(-25);
        job.progress = 0;
        saveLater();
        await run([...args.slice(0, -4), '-f', selectFormat(job.quality, job.isShort ? 'width' : 'height', false),
          '--merge-output-format', 'mkv', job.url]);
        job.formatFallback = true;
      }
      if (job.cancelled) throw new Error('Descarga cancelada');
      const extension = job.mode === 'audio' ? 'wav' : 'mp4';
      let source = path.join(tempDir, `${job.id}.${extension}`);
      if (job.formatFallback) {
        const files = await fs.readdir(tempDir);
        const downloaded = files.find((name) => name.startsWith(`${job.id}.`) && /\.(mp4|mkv|webm|mov)$/.test(name));
        if (!downloaded) throw new Error('No se generó un archivo de vídeo para convertir');
        job.state = 'converting';
        saveLater();
        const converted = path.join(tempDir, `${job.id}.converted.mp4`);
        await runTool(ffmpegPath, ['-y', '-i', path.join(tempDir, downloaded), '-map', '0:v:0', '-map', '0:a:0?',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', converted], job, { spawnProcess });
        source = converted;
      }
      if (job.mode === 'video' && !(await fs.stat(source).catch(() => null))?.size) {
        const files = await fs.readdir(tempDir);
        const videoPart = files.find((name) => name.startsWith(`${job.id}.f`) && name.endsWith('.mp4'));
        const audioPart = files.find((name) => name.startsWith(`${job.id}.f`) && /\.(m4a|aac)$/.test(name));
        if (videoPart && audioPart) {
          job.state = 'converting';
          job.logs = [...job.logs, 'Fusionando las pistas de vídeo y audio descargadas.'].slice(-25);
          saveLater();
          const merged = path.join(tempDir, `${job.id}.merged.mp4`);
          await runTool(ffmpegPath, ['-y', '-i', path.join(tempDir, videoPart), '-i', path.join(tempDir, audioPart),
            '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', merged],
          job, { spawnProcess });
          source = merged;
        }
      }
      const size = (await fs.stat(source).catch(() => null))?.size;
      if (!size) throw new Error(`No se generó el archivo ${extension.toUpperCase()} final. Comprueba que ffmpeg y ffprobe estén disponibles.`);
      if (size > job.maxSizeGb * 1024 ** 3) throw new Error(`El archivo supera el límite de ${job.maxSizeGb} GB`);
      job.state = 'saving';
      saveLater();
      const targetDir = job.mode === 'audio' ? audioDir : videosDir;
      const target = path.join(targetDir, `${job.id}.${extension}`);
      const staged = `${target}.upload`;
      await fs.copyFile(source, staged);
      try {
        const item = await serializeMutation(async () => {
          const catalog = job.mode === 'audio' ? await readManifest() : await readVideos();
          if (alreadySaved(catalog, job.url)) throw new Error('Este vídeo ya está en la biblioteca');
          await fs.rename(staged, target);
          try {
            if (job.mode === 'audio') {
              const sound = { id: job.id, title: job.title, category: 'sfx', tags: ['youtube'],
                duration: job.duration, addedAt: Date.now(), favorite: false, playCount: 0,
                sourceUrl: job.url, sourceType: 'published', file: `${job.id}.wav` };
              await writeManifest([sound, ...catalog]);
              return sound;
            }
            const video = { id: job.id, title: job.title, category: job.category, format: 'MP4',
              durationText: `${String(Math.floor(job.duration / 60)).padStart(2, '0')}:${String(Math.floor(job.duration % 60)).padStart(2, '0')}`,
              notes: '', favorite: false, sourceUrl: job.url, localPath: `/assets/videos/${job.id}.mp4` };
            await writeVideos([video, ...catalog]);
            return video;
          } catch (error) { await fs.unlink(target).catch(() => {}); throw error; }
        });
        job.item = item;
        job.progress = 100;
        job.state = 'done';
      } finally { await fs.unlink(staged).catch(() => {}); }
    } catch (error) {
      job.state = job.cancelled ? 'cancelled' : 'error';
      job.error = error.message || 'No se pudo descargar el recurso';
    } finally {
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      job.finishedAt = Date.now();
      saveLater();
    }
  }

  async function start(url, mode, category = 'b-roll', quality = 'best', maxSizeGb = MAX_SIZE_GB) {
    const canonical = youtubeVideoUrl(url);
    const selectedCategory = typeof category === 'string' ? category.trim() : '';
    if (!canonical) { const error = new Error('URL no válida: pega un enlace directo a un vídeo o Short de YouTube'); error.status = 400; throw error; }
    if (!['audio', 'video'].includes(mode)) { const error = new Error('Elige vídeo o audio'); error.status = 400; throw error; }
    if (mode === 'video' && (!selectedCategory || selectedCategory.length > 40)) {
      const error = new Error('Escribe una categoría de hasta 40 caracteres'); error.status = 400; throw error;
    }
    if (mode === 'video' && !QUALITIES.has(quality)) { const error = new Error('Calidad no válida'); error.status = 400; throw error; }
    if (!Number.isInteger(maxSizeGb) || maxSizeGb < 1 || maxSizeGb > MAX_SIZE_GB) {
      const error = new Error(`El límite debe estar entre 1 y ${MAX_SIZE_GB} GB`); error.status = 400; throw error;
    }
    if (starting || [...jobs.values()].some((job) => ACTIVE.has(job.state))) {
      const error = new Error('Ya hay una descarga en curso'); error.status = 409; throw error;
    }
    starting = true;
    try {
      const catalog = mode === 'audio' ? await readManifest() : await readVideos();
      const existing = alreadySaved(catalog, canonical);
      if (existing) {
        const error = new Error('Este vídeo ya está en la biblioteca'); error.status = 409; error.existingId = existing.id; throw error;
      }
      const job = { id: `yt-${randomUUID()}`, url: canonical, originalUrl: url.trim(), mode, category: mode === 'video' ? selectedCategory : null,
        quality: mode === 'video' ? quality : null, maxSizeGb,
        isShort: /\/shorts\//.test(new URL(url).pathname), formatFallback: false,
        state: 'checking', progress: 0, title: '', duration: 0, logs: [], startedAt: Date.now(), finishedAt: null,
        error: null, item: null, child: null, cancelled: false };
      jobs.set(job.id, job);
      if (jobs.size > 50) {
        const oldest = [...jobs.values()].find((entry) => FINISHED.has(entry.state));
        if (oldest) jobs.delete(oldest.id);
      }
      try { await persist(); }
      catch (error) { jobs.delete(job.id); throw error; }
      execution = execute(job);
      return publicJob(job);
    } finally { starting = false; }
  }

  async function retry(id) {
    const previous = jobs.get(id);
    if (!previous) return null;
    if (!['error', 'cancelled', 'interrupted'].includes(previous.state)) {
      const error = new Error('Solo se pueden reintentar tareas fallidas o interrumpidas'); error.status = 409; throw error;
    }
    return start(previous.originalUrl || previous.url, previous.mode, previous.category || 'b-roll',
      previous.quality || 'best', previous.maxSizeGb || MAX_SIZE_GB);
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return null;
    if (['checking', 'downloading', 'converting'].includes(job.state)) {
      job.cancelled = true;
      if (job.child?.pid && process.platform === 'win32' && spawnProcess === spawn) {
        spawn('taskkill', ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else job.child?.kill();
      saveLater();
    }
    return publicJob(job);
  }

  const flush = async () => { await execution; await pendingWrite; };
  return { list, get, restore, start, retry, cancel, flush };
}

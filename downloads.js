import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_FILE = 2 * 1024 * 1024 * 1024;
const VIDEO_FORMAT = 'bv[vcodec^=avc][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv[ext=mp4]+ba[ext=m4a]';

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
      if (!capture && !clean.startsWith('download:')) {
        job.logs = [...job.logs, clean.slice(0, 300)].slice(-25);
      }
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
      else if (code !== 0) reject(new Error(tail || `yt-dlp terminó con código ${code}`));
      else resolve(output);
    });
  });
}

export function createDownloadManager({ audioDir, videosDir, readManifest, writeManifest, readVideos, writeVideos,
  serializeMutation, spawnProcess = spawn, ytDlpPath = process.env.YTDLP_PATH || 'yt-dlp',
  ffmpegPath = process.env.FFMPEG_PATH }) {
  const jobs = new Map();
  const publicJob = (job) => {
    const { child, cancelled, ...visible } = job;
    return visible;
  };
  const list = () => [...jobs.values()].reverse().map(publicJob);
  const get = (id) => jobs.has(id) ? publicJob(jobs.get(id)) : null;

  async function execute(job) {
    let tempDir;
    try {
      job.state = 'checking';
      const existing = job.mode === 'audio' ? await readManifest() : await readVideos();
      if (existing.some((entry) => entry.sourceUrl === job.url)) throw new Error('Este vídeo ya está en la biblioteca');
      if (job.cancelled) throw new Error('Descarga cancelada');
      const common = ['--ignore-config', '--no-playlist', '--no-exec', '--no-warnings'];
      const run = (args, capture = false) => runTool(ytDlpPath, [...common, ...args], job, { spawnProcess, capture });
      const raw = await run(['--dump-single-json', '--skip-download', job.url], true);
      if (job.cancelled) throw new Error('Descarga cancelada');
      const info = JSON.parse(raw);
      job.title = String(info.title || 'Vídeo de YouTube').slice(0, 200);
      job.duration = Number.isFinite(info.duration) ? info.duration : 0;
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rotvault-download-'));
      const output = path.join(tempDir, `${job.id}.%(ext)s`);
      const args = ['--newline', '--max-filesize', '2G', '--progress-template', 'download:%(progress._percent_str)s'];
      if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath);
      args.push('-o', output);
      if (job.mode === 'audio') args.push('-f', 'ba/b', '-x', '--audio-format', 'wav');
      else args.push('-f', VIDEO_FORMAT, '--merge-output-format', 'mp4');
      job.state = 'downloading';
      await run([...args, job.url]);
      if (job.cancelled) throw new Error('Descarga cancelada');
      const extension = job.mode === 'audio' ? 'wav' : 'mp4';
      const files = await fs.readdir(tempDir);
      const filename = `${job.id}.${extension}`;
      if (!files.includes(filename)) throw new Error(`No se generó un archivo ${extension.toUpperCase()}. Comprueba ffmpeg y los formatos disponibles.`);
      const source = path.join(tempDir, filename);
      const size = (await fs.stat(source)).size;
      if (!size || size > MAX_FILE) throw new Error('El archivo está vacío o supera 2 GB');
      job.state = 'saving';
      const targetDir = job.mode === 'audio' ? audioDir : videosDir;
      const target = path.join(targetDir, filename);
      const staged = `${target}.upload`;
      await fs.copyFile(source, staged);
      try {
        const item = await serializeMutation(async () => {
          const list = job.mode === 'audio' ? await readManifest() : await readVideos();
          if (list.some((entry) => entry.sourceUrl === job.url)) {
            const error = new Error('Este vídeo ya está en la biblioteca'); error.status = 409; throw error;
          }
          await fs.rename(staged, target);
          try {
            if (job.mode === 'audio') {
              const sound = { id: job.id, title: job.title, category: 'sfx', tags: ['youtube'],
                duration: job.duration, addedAt: Date.now(), favorite: false, playCount: 0,
                sourceUrl: job.url, sourceType: 'published', file: filename };
              await writeManifest([sound, ...list]);
              return sound;
            }
            const video = { id: job.id, title: job.title, category: job.category, format: 'MP4',
              durationText: `${String(Math.floor(job.duration / 60)).padStart(2, '0')}:${String(Math.floor(job.duration % 60)).padStart(2, '0')}`,
              notes: '', favorite: false, sourceUrl: job.url, localPath: `/assets/videos/${filename}` };
            await writeVideos([video, ...list]);
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
    }
  }

  function start(url, mode, category = 'b-roll') {
    const canonical = youtubeVideoUrl(url);
    const selectedCategory = typeof category === 'string' ? category.trim() : '';
    if (!canonical) { const error = new Error('URL no válida: pega un enlace directo a un vídeo de YouTube'); error.status = 400; throw error; }
    if (!['audio', 'video'].includes(mode)) { const error = new Error('Elige vídeo o audio'); error.status = 400; throw error; }
    if (mode === 'video' && (!selectedCategory || selectedCategory.length > 40)) {
      const error = new Error('Escribe una categoría de hasta 40 caracteres'); error.status = 400; throw error;
    }
    if ([...jobs.values()].some((job) => ['checking', 'downloading', 'saving'].includes(job.state))) {
      const error = new Error('Ya hay una descarga en curso'); error.status = 409; throw error;
    }
    const job = { id: `yt-${randomUUID()}`, url: canonical, mode, category: mode === 'video' ? selectedCategory : null,
      state: 'checking', progress: 0,
      title: '', duration: 0, logs: [], startedAt: Date.now(), finishedAt: null, error: null,
      item: null, child: null, cancelled: false };
    jobs.set(job.id, job);
    if (jobs.size > 20) {
      const old = [...jobs.values()].find((entry) => !['checking', 'downloading', 'saving'].includes(entry.state));
      if (old) jobs.delete(old.id);
    }
    void execute(job);
    return publicJob(job);
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return null;
    if (['checking', 'downloading'].includes(job.state)) {
      job.cancelled = true;
      if (job.child?.pid && process.platform === 'win32' && spawnProcess === spawn) {
        spawn('taskkill', ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else job.child?.kill();
    }
    return publicJob(job);
  }

  return { list, get, start, cancel };
}

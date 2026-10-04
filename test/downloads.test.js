import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createDownloadManager, youtubeVideoUrl } from '../downloads.js';

const fixture = fileURLToPath(new URL('../fixtures/fake-ytdlp.js', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function completed(manager, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = manager.get(id);
    if (['done', 'error', 'cancelled', 'interrupted'].includes(job.state)) return job;
    await sleep(20);
  }
  throw new Error('La descarga de prueba no terminó');
}

async function setup(t, { writeFails = false, wait = false, formatFallback = false, portrait = false, unmerged = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rotvault-download-test-'));
  const managers = [];
  t.after(async () => {
    await Promise.all(managers.map((instance) => instance.flush()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const audioDir = path.join(root, 'audio');
  const videosDir = path.join(root, 'videos');
  await Promise.all([fs.mkdir(audioDir), fs.mkdir(videosDir)]);
  let sounds = [];
  let videos = [];
  const jobsPath = path.join(root, 'download-jobs.json');
  const calls = [];
  let waitForDownload = wait;
  const options = { audioDir, videosDir, jobsPath,
    readManifest: async () => sounds,
    writeManifest: async (next) => { if (writeFails) throw new Error('Falló el catálogo'); sounds = next; },
    readVideos: async () => videos,
    writeVideos: async (next) => { if (writeFails) throw new Error('Falló el catálogo'); videos = next; },
    serializeMutation: (work) => work(),
    spawnProcess: (binary, args, processOptions) => {
      calls.push({ binary, args });
      return spawn(process.execPath, [fixture, ...args], {
      ...processOptions, env: { ...process.env, FAKE_YTDLP_WAIT: waitForDownload ? '1' : '0',
        FAKE_FORMAT_FAIL: formatFallback ? '1' : '0', FAKE_PORTRAIT: portrait ? '1' : '0',
        FAKE_UNMERGED: unmerged ? '1' : '0',
        FAKE_TOOL: binary === 'ffmpeg' ? 'ffmpeg' : 'yt-dlp' },
      });
    },
  };
  const manager = createDownloadManager(options);
  managers.push(manager);
  return { manager, createManager: () => {
    const next = createDownloadManager(options);
    managers.push(next);
    return next;
  }, setWait: (value) => { waitForDownload = value; },
    calls, jobsPath, audioDir, videosDir,
    getSounds: () => sounds, getVideos: () => videos };
}

test('solo acepta enlaces directos a un vídeo concreto de YouTube', () => {
  assert.equal(youtubeVideoUrl('https://youtu.be/abcdefghijk?t=5'), 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(youtubeVideoUrl('https://www.youtube.com/shorts/abcdefghijk'), 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(youtubeVideoUrl('http://music.youtube.com/watch?v=abcdefghijk'), 'https://www.youtube.com/watch?v=abcdefghijk');
  for (const url of ['https://youtube.com.evil.test/watch?v=abcdefghijk',
    'https://youtube.com/playlist?list=abc', 'https://youtube.com/watch?v=bad', 'file:///etc/passwd']) {
    assert.equal(youtubeVideoUrl(url), null);
  }
});

test('guarda vídeo y audio en las bibliotecas correctas', async (t) => {
  const { manager, createManager, audioDir, videosDir, getSounds, getVideos } = await setup(t);
  const url = 'https://www.youtube.com/watch?v=abcdefghijk';
  const videoJob = await manager.start(url, 'video', 'Montajes');
  assert.equal((await completed(manager, videoJob.id)).state, 'done');
  assert.equal(getVideos()[0].sourceUrl, url);
  assert.equal(getVideos()[0].category, 'Montajes');
  assert.ok((await fs.stat(path.join(videosDir, `${videoJob.id}.mp4`))).size > 0);
  const audioJob = await manager.start(url, 'audio');
  assert.equal((await completed(manager, audioJob.id)).state, 'done');
  assert.equal(getSounds()[0].sourceUrl, url);
  assert.ok((await fs.stat(path.join(audioDir, `${audioJob.id}.wav`))).size > 0);
  await assert.rejects(manager.start(url, 'audio'), /ya está en la biblioteca/);
  assert.equal(getSounds().length, 1);
  await manager.flush();
  const recovered = createManager();
  await recovered.restore();
  assert.deepEqual(recovered.list().map((item) => item.id), [audioJob.id, videoJob.id]);
});

test('un fallo al escribir el catálogo retira el archivo descargado', async (t) => {
  const { manager, videosDir, getVideos } = await setup(t, { writeFails: true });
  const job = await manager.start('https://youtu.be/abcdefghijk', 'video');
  assert.equal((await completed(manager, job.id)).state, 'error');
  assert.deepEqual(await fs.readdir(videosDir), []);
  assert.deepEqual(getVideos(), []);
});

test('se puede cancelar y solo hay una descarga simultánea', async (t) => {
  const { manager, videosDir } = await setup(t, { wait: true });
  const job = await manager.start('https://youtu.be/abcdefghijk', 'video');
  await assert.rejects(manager.start('https://youtu.be/zzzzzzzzzzz', 'video'), /en curso/);
  for (let i = 0; i < 50 && manager.get(job.id).state !== 'downloading'; i++) await sleep(20);
  manager.cancel(job.id);
  assert.equal((await completed(manager, job.id)).state, 'cancelled');
  assert.deepEqual(await fs.readdir(videosDir), []);
});

test('aplica la calidad al lado corto de un Short vertical', async (t) => {
  const { manager, calls } = await setup(t, { portrait: true });
  const job = await manager.start('https://www.youtube.com/shorts/abcdefghijk', 'video', 'Shorts', '720');
  assert.equal((await completed(manager, job.id)).state, 'done');
  assert.equal(manager.get(job.id).isShort, true);
  assert.ok(calls.some(({ args }) => args.some((arg) => arg.includes('[width<=?720]'))));
  await assert.rejects(manager.start('https://youtu.be/abcdefghijk', 'video'), /ya está en la biblioteca/);
  await assert.rejects(manager.start('https://youtu.be/zzzzzzzzzzz', 'video', 'b-roll', '1440'), /Calidad no válida/);
});

test('convierte formatos alternativos a MP4 cuando no hay uno compatible', async (t) => {
  const { manager, calls, videosDir } = await setup(t, { formatFallback: true });
  const job = await manager.start('https://youtu.be/abcdefghijk', 'video', 'b-roll', '480');
  assert.equal((await completed(manager, job.id)).state, 'done');
  assert.equal(manager.get(job.id).formatFallback, true);
  assert.ok(calls.some(({ binary }) => binary === 'ffmpeg'));
  assert.equal(await fs.readFile(path.join(videosDir, `${job.id}.mp4`), 'utf8'), 'converted-video');
});

test('usa 10 GB por defecto y permite un límite menor por tarea', async (t) => {
  const { manager, calls } = await setup(t);
  const first = await manager.start('https://youtu.be/abcdefghijk', 'video');
  assert.equal((await completed(manager, first.id)).state, 'done');
  assert.equal(first.maxSizeGb, 10);
  assert.ok(calls.some(({ args }) => args.includes('10G')));
  assert.ok(calls.every(({ args }) => !args.includes('--ffmpeg-location')));
  const second = await manager.start('https://youtu.be/zzzzzzzzzzz', 'video', 'b-roll', 'best', 5);
  assert.equal((await completed(manager, second.id)).state, 'done');
  assert.equal(second.maxSizeGb, 5);
  assert.ok(calls.some(({ args }) => args.includes('5G')));
  await assert.rejects(manager.start('https://youtu.be/yyyyyyyyyyy', 'video', 'b-roll', 'best', 11), /entre 1 y 10 GB/);
});

test('fusiona pistas separadas si yt-dlp termina sin crear el MP4 final', async (t) => {
  const { manager, calls, videosDir } = await setup(t, { unmerged: true });
  const job = await manager.start('https://youtu.be/abcdefghijk', 'video');
  assert.equal((await completed(manager, job.id)).state, 'done');
  assert.ok(calls.some(({ binary, args }) => binary === 'ffmpeg' && args.includes('1:a:0')));
  assert.equal(await fs.readFile(path.join(videosDir, `${job.id}.mp4`), 'utf8'), 'converted-video');
});

test('recupera tareas interrumpidas del disco y permite reintentarlas', async (t) => {
  const { manager, createManager, setWait, jobsPath } = await setup(t, { wait: true });
  const job = await manager.start('https://youtu.be/abcdefghijk', 'video', 'Shorts', '720');
  assert.ok((await fs.readFile(jobsPath, 'utf8')).includes(job.id));
  const recovered = createManager();
  await recovered.restore();
  assert.equal(recovered.get(job.id).state, 'interrupted');
  assert.equal(recovered.get(job.id).quality, '720');
  manager.cancel(job.id);
  assert.equal((await completed(manager, job.id)).state, 'cancelled');
  setWait(false);
  const retried = await recovered.retry(job.id);
  assert.equal((await completed(recovered, retried.id)).state, 'done');
  assert.equal(retried.quality, '720');
});

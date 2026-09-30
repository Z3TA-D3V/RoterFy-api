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
    if (['done', 'error', 'cancelled'].includes(job.state)) return job;
    await sleep(20);
  }
  throw new Error('La descarga de prueba no terminó');
}

async function setup(t, { writeFails = false, wait = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rotvault-download-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const audioDir = path.join(root, 'audio');
  const videosDir = path.join(root, 'videos');
  await Promise.all([fs.mkdir(audioDir), fs.mkdir(videosDir)]);
  let sounds = [];
  let videos = [];
  const manager = createDownloadManager({ audioDir, videosDir,
    readManifest: async () => sounds,
    writeManifest: async (next) => { if (writeFails) throw new Error('Falló el catálogo'); sounds = next; },
    readVideos: async () => videos,
    writeVideos: async (next) => { if (writeFails) throw new Error('Falló el catálogo'); videos = next; },
    serializeMutation: (work) => work(),
    spawnProcess: (_bin, args, options) => spawn(process.execPath, [fixture, ...args], {
      ...options, env: { ...process.env, FAKE_YTDLP_WAIT: wait ? '1' : '0' },
    }),
  });
  return { manager, audioDir, videosDir, getSounds: () => sounds, getVideos: () => videos };
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
  const { manager, audioDir, videosDir, getSounds, getVideos } = await setup(t);
  const url = 'https://www.youtube.com/watch?v=abcdefghijk';
  const videoJob = manager.start(url, 'video', 'Montajes');
  assert.equal((await completed(manager, videoJob.id)).state, 'done');
  assert.equal(getVideos()[0].sourceUrl, url);
  assert.equal(getVideos()[0].category, 'Montajes');
  assert.ok((await fs.stat(path.join(videosDir, `${videoJob.id}.mp4`))).size > 0);
  const audioJob = manager.start(url, 'audio');
  assert.equal((await completed(manager, audioJob.id)).state, 'done');
  assert.equal(getSounds()[0].sourceUrl, url);
  assert.ok((await fs.stat(path.join(audioDir, `${audioJob.id}.wav`))).size > 0);
  const repeated = manager.start(url, 'audio');
  assert.match((await completed(manager, repeated.id)).error, /ya está en la biblioteca/);
  assert.equal(getSounds().length, 1);
});

test('un fallo al escribir el catálogo retira el archivo descargado', async (t) => {
  const { manager, videosDir, getVideos } = await setup(t, { writeFails: true });
  const job = manager.start('https://youtu.be/abcdefghijk', 'video');
  assert.equal((await completed(manager, job.id)).state, 'error');
  assert.deepEqual(await fs.readdir(videosDir), []);
  assert.deepEqual(getVideos(), []);
});

test('se puede cancelar y solo hay una descarga simultánea', async (t) => {
  const { manager, videosDir } = await setup(t, { wait: true });
  const job = manager.start('https://youtu.be/abcdefghijk', 'video');
  assert.throws(() => manager.start('https://youtu.be/zzzzzzzzzzz', 'video'), /en curso/);
  for (let i = 0; i < 50 && manager.get(job.id).state !== 'downloading'; i++) await sleep(20);
  manager.cancel(job.id);
  assert.equal((await completed(manager, job.id)).state, 'cancelled');
  assert.deepEqual(await fs.readdir(videosDir), []);
});

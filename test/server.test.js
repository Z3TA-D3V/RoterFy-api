import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const apiDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('la API persiste y borra guiones, vídeos y audios con portada', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'rotvault-api-test-'));
  const audioDir = path.join(temporaryRoot, 'assets', 'audio');
  mkdirSync(audioDir, { recursive: true });
  writeFileSync(path.join(audioDir, 'manifest.json'), '[]\n');
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(apiDir, 'server.js')], {
    cwd: apiDir,
    env: { ...process.env, PORT: String(port), AUDIO_DIR: audioDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`La API no arrancó: ${stderr}`)), 5000);
      child.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('RotVault API:')) { clearTimeout(timer); resolve(); }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`La API terminó (${code}): ${stderr}`)); });
    });
    const base = `http://127.0.0.1:${port}/api`;
    const json = (value) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

    assert.equal((await fetch(`${base}/downloads`, json({ url: 'https://example.com/video', mode: 'video' }))).status, 400);
    assert.equal((await fetch(`${base}/downloads`, json({ url: 'https://youtu.be/abcdefghijk', mode: 'video', quality: '1440' }))).status, 400);
    assert.equal((await fetch(`${base}/downloads`, json({ url: 'https://youtu.be/abcdefghijk', mode: 'video', maxSizeGb: 11 }))).status, 400);
    assert.equal((await fetch(`${base}/downloads/missing/retry`, { method: 'POST' })).status, 404);
    assert.deepEqual(await (await fetch(`${base}/downloads`)).json(), []);
    assert.equal((await fetch(`${base}/downloads/missing/file`)).status, 404);
    assert.doesNotMatch(stderr, /URL no válida/);

    assert.equal((await fetch(`${base}/scripts`, { headers: { Origin: 'https://unknown.example' } })).status, 403);
    const preflight = await fetch(`${base}/scripts`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods'), /PUT/);
    assert.equal((await fetch(`${base}/scripts`, json({ id: '../escape', title: 'X' }))).status, 400);

    const script = { id: 'script-test', title: 'Prueba', content: 'Texto', category: 'hook', status: 'idea', updatedAt: 1 };
    assert.equal((await fetch(`${base}/scripts`, json(script))).status, 200);
    assert.deepEqual(await (await fetch(`${base}/scripts`)).json(), [script]);
    assert.deepEqual(await (await fetch(`${base}/scripts/script-test/recordings`)).json(), []);
    assert.equal((await fetch(`${base}/scripts/missing/recordings`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.from('voice') })).status, 404);
    const takeResponse = await fetch(`${base}/scripts/script-test/recordings`, {
      method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.from('voice-test'),
    });
    assert.equal(takeResponse.status, 201);
    const take = await takeResponse.json();
    assert.equal(take.scriptId, script.id);
    assert.ok(existsSync(path.join(temporaryRoot, 'assets', 'recordings', take.originalFile)));
    assert.equal((await (await fetch(`${base}/scripts/script-test/recordings`)).json()).length, 1);
    assert.equal((await fetch(`${base}/scripts/other/recordings/${take.id}/file`)).status, 404);
    assert.equal(await (await fetch(`${base}/scripts/script-test/recordings/${take.id}/file`)).text(), 'voice-test');
    const editedUrl = `${base}/scripts/script-test/recordings/${take.id}/edited`;
    const edit = { startSec: 0, endSec: 1, gain: 1, normalize: true, fadeIn: 0, fadeOut: 0 };
    assert.equal((await fetch(editedUrl, { method: 'PUT', headers: { 'Content-Type': 'audio/wav', 'X-Edit-Settings': JSON.stringify(edit) }, body: Buffer.from('bad-audio') })).status, 400);
    const voiceWav = Buffer.alloc(48);
    voiceWav.write('RIFF', 0); voiceWav.write('WAVE', 8);
    const editResponse = await fetch(editedUrl, { method: 'PUT', headers: { 'Content-Type': 'audio/wav', 'X-Edit-Settings': JSON.stringify(edit) }, body: voiceWav });
    assert.equal(editResponse.status, 200);
    const editedRecording = await editResponse.json();
    assert.ok(editedRecording.editedFile.startsWith(take.id));
    assert.deepEqual(editedRecording.edit, edit);
    assert.deepEqual(Buffer.from(await (await fetch(`${base}/scripts/script-test/recordings/${take.id}/file?variant=edited`)).arrayBuffer()), voiceWav);
    assert.equal((await fetch(`${base}/scripts/script-test/recordings/${take.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await (await fetch(`${base}/scripts/script-test/recordings`)).json()).length, 0);
    assert.ok(!existsSync(path.join(temporaryRoot, 'assets', 'recordings', take.originalFile)));
    assert.equal((await fetch(`${base}/scripts/script-test`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/scripts/script-test`, { method: 'DELETE' })).status, 404);
    assert.deepEqual(JSON.parse(readFileSync(path.join(temporaryRoot, 'assets', 'data', 'scripts.json'))), []);

    const video = { id: 'video-test', title: 'Clip', category: 'b-roll', format: '16:9', durationText: '00:01', notes: '', favorite: false };
    assert.equal((await fetch(`${base}/stock-videos`, json(video))).status, 200);
    assert.equal((await fetch(`${base}/stock-videos/video-test/file`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('bad'),
    })).status, 400);
    assert.equal((await fetch(`${base}/stock-videos/missing/file`, {
      method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.from('video-demo'),
    })).status, 404);
    assert.equal((await fetch(`${base}/stock-videos/video-test/file`, {
      method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.from('video-demo'),
    })).status, 200);
    const videoFile = path.join(temporaryRoot, 'assets', 'videos', 'video-test.mp4');
    assert.ok(existsSync(videoFile));
    const browserVideo = await fetch(`${base}/downloads/video-test/file`);
    assert.equal(browserVideo.status, 200);
    assert.match(browserVideo.headers.get('content-disposition'), /attachment/);
    assert.equal(await browserVideo.text(), 'video-demo');
    const recategorized = await (await fetch(`${base}/stock-videos`, json({ ...video, category: 'Montajes' }))).json();
    assert.equal(recategorized.category, 'Montajes');
    assert.equal(recategorized.localPath, '/assets/videos/video-test.mp4');
    assert.ok(existsSync(videoFile));
    assert.equal((await fetch(`${base}/stock-videos/video-test`, { method: 'DELETE' })).status, 204);
    assert.ok(!existsSync(videoFile));

    const wav = Buffer.alloc(44);
    wav.write('RIFF', 0);
    wav.write('WAVE', 8);
    const cover = Buffer.from('jpeg-demo-image');
    const sound = { id: 'sound-test', title: 'Nuevo', category: 'sfx', coverImage: 'blob:preview',
      addedAt: 123, favorite: false, playCount: 0, tags: ['primero'] };
    assert.equal((await fetch(`${base}/sounds`, json({ sound, audioBase64: Buffer.from('bad').toString('base64') }))).status, 400);
    assert.equal((await fetch(`${base}/sounds`, json({ sound, audioBase64: wav.toString('base64'), coverBase64: 'data:image/svg+xml;base64,PHN2Zz4=' }))).status, 400);
    const created = await fetch(`${base}/sounds`, json({ sound, audioBase64: wav.toString('base64'),
      coverBase64: `data:image/jpeg;base64,${cover.toString('base64')}` }));
    assert.equal(created.status, 201);
    assert.equal((await created.json()).coverImage, '/assets/images/sound-test.jpg');
    const browserAudio = await fetch(`${base}/downloads/sound-test/file`);
    assert.equal(browserAudio.status, 200);
    assert.match(browserAudio.headers.get('content-disposition'), /attachment/);
    assert.deepEqual(Buffer.from(await browserAudio.arrayBuffer()), wav);
    assert.equal((await fetch(`${base}/sounds`, json({ sound, audioBase64: wav.toString('base64') }))).status, 409);
    const coverFile = path.join(temporaryRoot, 'assets', 'images', 'sound-test.jpg');
    assert.ok(existsSync(coverFile));
    const edited = await fetch(`${base}/sounds/sound-test`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'other-id', file: 'other.wav', favorite: true }) });
    assert.equal(edited.status, 200);
    assert.deepEqual(((await edited.json()).id), 'sound-test');
    assert.equal((await fetch(`${base}/sounds/sound-test/play`, { method: 'POST' })).status, 200);
    assert.equal((await (await fetch(`${base}/sounds`)).json())[0].playCount, 1);

    const revisedWav = Buffer.alloc(48, 7);
    revisedWav.write('RIFF', 0);
    revisedWav.write('WAVE', 8);
    const revisedCover = Buffer.from('webp-demo-image');
    const update = (id, details, audio = revisedWav, coverBase64) => fetch(`${base}/sounds/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sound: details, audioBase64: audio.toString('base64'), coverBase64 }),
    });
    assert.equal((await update('sound-test', { ...sound, id: 'other-id' })).status, 400);
    assert.equal((await update('missing', { ...sound, id: 'missing' })).status, 404);
    assert.equal((await update('sound-test', sound, Buffer.from('bad'))).status, 400);
    assert.deepEqual(readFileSync(path.join(audioDir, 'sound-test.wav')), wav);

    const revisedCoverFile = path.join(temporaryRoot, 'assets', 'images', 'sound-test.webp');
    writeFileSync(revisedCoverFile, 'portada ajena');
    assert.equal((await update('sound-test', sound, revisedWav,
      `data:image/webp;base64,${revisedCover.toString('base64')}`)).status, 409);
    assert.equal(readFileSync(revisedCoverFile, 'utf8'), 'portada ajena');
    assert.deepEqual(readFileSync(path.join(audioDir, 'sound-test.wav')), wav);
    unlinkSync(revisedCoverFile);

    const replaced = await update('sound-test', { ...sound, title: 'Editado', tags: ['nuevo'], favorite: false,
      playCount: 999, addedAt: 999, coverImage: 'blob:preview' }, revisedWav,
      `data:image/webp;base64,${revisedCover.toString('base64')}`);
    assert.equal(replaced.status, 200);
    const replacement = await replaced.json();
    assert.equal(replacement.id, sound.id);
    assert.equal(replacement.file, 'sound-test.wav');
    assert.equal(replacement.title, 'Editado');
    assert.deepEqual(replacement.tags, ['nuevo']);
    assert.equal(replacement.addedAt, 123);
    assert.equal(replacement.playCount, 1);
    assert.equal(replacement.favorite, true);
    assert.equal(replacement.coverImage, '/assets/images/sound-test.webp');
    assert.deepEqual(readFileSync(path.join(audioDir, 'sound-test.wav')), revisedWav);
    assert.ok(!existsSync(coverFile));
    assert.deepEqual(readFileSync(revisedCoverFile), revisedCover);
    assert.equal((await (await fetch(`${base}/sounds`)).json()).length, 1);

    const manifestTempObstacle = path.join(audioDir, `manifest.json.${child.pid}.tmp`);
    mkdirSync(manifestTempObstacle);
    try {
      const failedWav = Buffer.from(revisedWav);
      failedWav[20] = 99;
      const failed = await update('sound-test', { ...sound, title: 'No debe guardarse' }, failedWav,
        `data:image/png;base64,${Buffer.from('png-demo-image').toString('base64')}`);
      assert.equal(failed.status, 500);
      assert.deepEqual(readFileSync(path.join(audioDir, 'sound-test.wav')), revisedWav);
      assert.deepEqual(readFileSync(revisedCoverFile), revisedCover);
      assert.ok(!existsSync(path.join(temporaryRoot, 'assets', 'images', 'sound-test.png')));
      assert.equal((await (await fetch(`${base}/sounds`)).json())[0].title, 'Editado');
    } finally { rmdirSync(manifestTempObstacle); }

    const preset = await update('sound-test', { ...sound, title: 'Con preset', coverImage: '/assets/images/vine_boom.jpg' });
    assert.equal(preset.status, 200);
    assert.equal((await preset.json()).coverImage, '/assets/images/vine_boom.jpg');
    assert.ok(!existsSync(revisedCoverFile));
    assert.equal((await (await fetch(`${base}/sounds`)).json()).length, 1);

    assert.equal((await fetch(`${base}/sounds/sound-test`, { method: 'DELETE' })).status, 204);
    assert.ok(!existsSync(coverFile));
    assert.equal((await fetch(`${base}/sounds/sound-test`, { method: 'DELETE' })).status, 404);
    assert.equal((await fetch(`${base}/sounds/sound-test/play`, { method: 'POST' })).status, 404);

    const legacy = { ...sound, id: 'legacy', title: 'Importado', file: '002-legacy.wav' };
    writeFileSync(path.join(audioDir, 'manifest.json'), `${JSON.stringify([legacy])}\n`);
    writeFileSync(path.join(audioDir, legacy.file), wav);
    const legacyEdit = await update('legacy', { ...legacy, title: 'Importado editado' });
    assert.equal(legacyEdit.status, 200);
    assert.equal((await legacyEdit.json()).file, legacy.file);
    assert.deepEqual(readFileSync(path.join(audioDir, legacy.file)), revisedWav);
    assert.ok(!existsSync(path.join(audioDir, 'legacy.wav')));
    assert.equal((await (await fetch(`${base}/sounds`)).json()).length, 1);
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    const resolved = path.resolve(temporaryRoot);
    if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith('rotvault-api-test-')) {
      rmSync(resolved, { recursive: true, force: true });
    }
  }
});

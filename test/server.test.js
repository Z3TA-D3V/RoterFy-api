import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

    const script = { id: 'script-test', title: 'Prueba', content: 'Texto', category: 'hook', status: 'idea', updatedAt: 1 };
    assert.equal((await fetch(`${base}/scripts`, json(script))).status, 200);
    assert.deepEqual(await (await fetch(`${base}/scripts`)).json(), [script]);
    assert.equal((await fetch(`${base}/scripts/script-test`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(JSON.parse(readFileSync(path.join(temporaryRoot, 'assets', 'data', 'scripts.json'))), []);

    const video = { id: 'video-test', title: 'Clip', category: 'b-roll', format: '16:9', durationText: '00:01', notes: '', favorite: false };
    assert.equal((await fetch(`${base}/stock-videos`, json(video))).status, 200);
    assert.equal((await fetch(`${base}/stock-videos/video-test/file`, {
      method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.from('video-demo'),
    })).status, 200);
    const videoFile = path.join(temporaryRoot, 'assets', 'videos', 'video-test.mp4');
    assert.ok(existsSync(videoFile));
    assert.equal((await fetch(`${base}/stock-videos/video-test`, { method: 'DELETE' })).status, 204);
    assert.ok(!existsSync(videoFile));

    const wav = Buffer.alloc(44);
    wav.write('RIFF', 0);
    wav.write('WAVE', 8);
    const cover = Buffer.from('jpeg-demo-image');
    const sound = { id: 'sound-test', title: 'Nuevo', category: 'sfx', coverImage: 'blob:preview' };
    const created = await fetch(`${base}/sounds`, json({ sound, audioBase64: wav.toString('base64'),
      coverBase64: `data:image/jpeg;base64,${cover.toString('base64')}` }));
    assert.equal(created.status, 201);
    assert.equal((await created.json()).coverImage, '/assets/images/sound-test.jpg');
    const coverFile = path.join(temporaryRoot, 'assets', 'images', 'sound-test.jpg');
    assert.ok(existsSync(coverFile));
    assert.equal((await fetch(`${base}/sounds/sound-test`, { method: 'DELETE' })).status, 204);
    assert.ok(!existsSync(coverFile));
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    const resolved = path.resolve(temporaryRoot);
    if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith('rotvault-api-test-')) {
      rmSync(resolved, { recursive: true, force: true });
    }
  }
});

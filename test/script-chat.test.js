import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const apiDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('el chat transmite la respuesta y persiste historial, usage y coste', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rotvault-chat-test-'));
  const audioDir = path.join(root, 'audio');
  mkdirSync(audioDir);
  writeFileSync(path.join(audioDir, 'manifest.json'), '[]\n');
  let received;
  const mockOpenAI = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of [
      { type: 'response.output_text.delta', delta: '<chat>Listo</chat>' },
      { type: 'response.output_text.delta', delta: '<script># Nuevo</script>' },
      { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 } } } },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => mockOpenAI.listen(0, '127.0.0.1', resolve));
  const portServer = createServer();
  await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const child = spawn(process.execPath, [path.join(apiDir, 'server.js')], {
    cwd: apiDir, env: { ...process.env, PORT: String(port), AUDIO_DIR: audioDir, OPENAI_API_KEY: 'test-key',
      OPENAI_BASE_URL: `http://127.0.0.1:${mockOpenAI.address().port}/v1` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`La API no arrancó: ${stderr}`)), 5000);
      child.stdout.on('data', (chunk) => { if (chunk.toString().includes('RotVault API:')) { clearTimeout(timer); resolve(); } });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`La API terminó (${code}): ${stderr}`)); });
    });
    const base = `http://127.0.0.1:${port}/api`;
    const post = (value) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const script = { id: 'script-chat', title: 'Video', content: '# Actual', category: 'hook', status: 'idea', updatedAt: 1,
      systemPromptUsed: 'Estilo personalizado', chatHistory: [] };
    assert.equal((await fetch(`${base}/scripts`, post(script))).status, 200);
    const response = await fetch(`${base}/scripts/script-chat/chat`, post({ message: 'Mejora el inicio', model: 'gpt-6-luna', reasoningEffort: 'medium' }));
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ['delta', 'delta', 'done']);
    assert.equal(events.at(-1).assistant.usage.total_tokens, 120);
    assert.ok(events.at(-1).assistant.cost > 0);
    assert.equal(events.at(-1).script.chatHistory.length, 2);
    assert.equal(received.model, 'gpt-6-luna');
    assert.equal(received.reasoning.effort, 'medium');
    assert.equal(received.input[0].role, 'developer');
    assert.match(received.input[0].content, /Estilo personalizado/);
    assert.match(received.input[1].content, /# Actual/);
    const saved = (await (await fetch(`${base}/scripts`)).json())[0];
    assert.equal(saved.content, '# Actual');
    assert.equal(saved.chatHistory.length, 2);
    assert.equal(saved.totalCost, events.at(-1).assistant.cost);
    assert.equal(JSON.parse(readFileSync(path.join(root, 'data', 'scripts.json')))[0].chatHistory.length, 2);
  } finally {
    child.kill();
    await new Promise((resolve) => mockOpenAI.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

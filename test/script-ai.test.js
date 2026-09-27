import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildScriptInput, estimateCost, loadApiEnvironment } from '../script-ai.js';

test('el contexto incluye el prompt, el guión actual y solo los últimos ocho mensajes', () => {
  const script = { systemPromptUsed: 'Mi estilo', content: '# Versión actual', chatHistory: Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Mensaje ${index}` })) };
  const input = buildScriptInput(script, 'Nueva instrucción');
  assert.equal(input[0].role, 'developer');
  assert.match(input[0].content, /Mi estilo/);
  assert.match(input[1].content, /Versión actual/);
  assert.equal(input.length, 11);
  assert.equal(input[2].content, 'Mensaje 2');
  assert.equal(input.at(-1).content, 'Nueva instrucción');
});

test('el coste se calcula a partir de usage y descuenta tokens en caché', () => {
  assert.equal(estimateCost('gpt-6-luna', { input_tokens: 1000, output_tokens: 1000, input_tokens_details: { cached_tokens: 500 } }), 0.000555);
  assert.equal(estimateCost('gpt-6-luna', null), null);
});

test('lee api/.env sin sobrescribir una clave ya definida en el proceso', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'rotvault-env-test-'));
  const envFile = path.join(directory, '.env');
  const original = process.env.OPENAI_API_KEY;
  try {
    writeFileSync(envFile, 'OPENAI_API_KEY=clave-de-prueba\n');
    delete process.env.OPENAI_API_KEY;
    loadApiEnvironment(envFile);
    assert.equal(process.env.OPENAI_API_KEY, 'clave-de-prueba');
    process.env.OPENAI_API_KEY = 'clave-del-proceso';
    loadApiEnvironment(envFile);
    assert.equal(process.env.OPENAI_API_KEY, 'clave-del-proceso');
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
    rmSync(directory, { recursive: true, force: true });
  }
});

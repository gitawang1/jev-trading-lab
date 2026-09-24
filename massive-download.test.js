import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { API_ORIGIN, calendarChunks, collectChunk, curlRequest, downloadArchive, initialUrl, requestWithRetry, sha256, validateArchive } from './massive-download.js';

const row = (t, extra = {}) => ({ t, o: 1, h: 2, l: 0.5, c: 1.5, v: 0.125, ...extra });
const response = (results, next_url) => ({ status: 200, body: JSON.stringify({ results, next_url }) });

test('calendar chunks are deterministic seven-calendar-day inclusive ranges', () => {
  assert.deepEqual(calendarChunks('2024-01-01', '2024-01-16'), [
    { from: '2024-01-01', to: '2024-01-07' }, { from: '2024-01-08', to: '2024-01-14' }, { from: '2024-01-15', to: '2024-01-16' },
  ]);
});

test('URL requests adjusted one-minute aggregates with limit 50000', () => {
  assert.equal(initialUrl('NVDA', { from: '2024-01-01', to: '2024-01-07' }), `${API_ORIGIN}/v2/aggs/ticker/NVDA/range/1/minute/2024-01-01/2024-01-07?adjusted=true&sort=asc&limit=50000`);
});

test('curl bearer secret goes through stdin config, never argv or child environment', async () => {
  let captured;
  const spawnImpl = (command, argv, options) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let config = ''; child.stdin.on('data', data => { config += data; });
    captured = { command, argv, options, get config() { return config; } };
    queueMicrotask(() => { child.stdout.end('{}\n200'); child.stderr.end(); child.emit('close', 0); });
    return child;
  };
  process.env.MASSIVE_API_KEY = 'parent-secret';
  await curlRequest(`${API_ORIGIN}/x`, 'stdin-secret', { spawnImpl });
  delete process.env.MASSIVE_API_KEY;
  assert.ok(!captured.argv.join(' ').includes('stdin-secret'));
  assert.equal(captured.options.env.MASSIVE_API_KEY, undefined);
  assert.match(captured.config, /Authorization: Bearer stdin-secret/);
});

test('unsafe credential characters are rejected before curl', async () => {
  assert.throws(() => curlRequest(`${API_ORIGIN}/x`, 'bad\nkey', { spawnImpl: () => assert.fail('must not spawn') }), /unsafe/);
});

test('same-origin pagination retains every row and optional field exactly', async () => {
  const urls = [], first = `${API_ORIGIN}/first`, next = `${API_ORIGIN}/next`;
  const result = await collectChunk(first, { intervalMs: 0, request: async url => { urls.push(url); return url === first ? response([row(1, { vw: 1.2, n: 3, otc: true })], next) : response([row(2)], null); } });
  assert.deepEqual(urls, [first, next]); assert.equal(result.results[0].v, 0.125); assert.deepEqual(result.results[0], row(1, { vw: 1.2, n: 3, otc: true }));
});

test('cross-origin next_url is rejected without making that request', async () => {
  let calls = 0;
  await assert.rejects(collectChunk(`${API_ORIGIN}/first`, { intervalMs: 0, request: async () => { calls++; return response([], 'https://evil.example/steal'); } }), /cross-origin/);
  assert.equal(calls, 1);
});

test('pagination loops are detected', async () => {
  const url = `${API_ORIGIN}/same`;
  await assert.rejects(collectChunk(url, { intervalMs: 0, request: async () => response([], url) }), /loop/);
});

test('maximum page count bounds pagination', async () => {
  await assert.rejects(collectChunk(`${API_ORIGIN}/1`, { intervalMs: 0, maxPages: 1, request: async () => response([], `${API_ORIGIN}/2`) }), /Maximum page/);
});

test('429, 5xx, and network errors retry only to the configured bound', async () => {
  for (const failure of [{ status: 429, body: '' }, { status: 503, body: '' }, new Error('offline')]) {
    let calls = 0;
    await assert.rejects(requestWithRetry('x', { intervalMs: 0, maxRetries: 2, request: async () => { calls++; if (failure instanceof Error) throw failure; return failure; } }), /Retry limit/);
    assert.equal(calls, 3);
  }
});

test('401 and 403 fail immediately and permanently', async () => {
  for (const status of [401, 403]) { let calls = 0; await assert.rejects(requestWithRetry('x', { intervalMs: 0, maxRetries: 9, request: async () => { calls++; return { status, body: '' }; } }), /Permanent authentication/); assert.equal(calls, 1); }
});

test('default interval is thirteen seconds before a request', async () => {
  const waits = [];
  await requestWithRetry('x', { wait: async ms => waits.push(ms), request: async () => response([]) });
  assert.deepEqual(waits, [13_000]);
});

test('download writes completed chunks, checksums, and machine-readable manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'massive-test-'));
  const manifest = await downloadArchive({ symbol: 'NVDA', from: '2024-01-01', to: '2024-01-08', directory, apiKey: 'unused', intervalMs: 0, request: async url => response([row(url.includes('01-08') ? 2 : 1)]) });
  assert.equal(manifest.chunks.length, 2);
  for (const chunk of manifest.chunks) { const bytes = await readFile(join(directory, chunk.file)); assert.equal(chunk.sha256, sha256(bytes)); await assert.rejects(readFile(join(directory, `${chunk.file}.part`))); }
  assert.deepEqual(await validateArchive(directory), { chunks: 2, rows: 2 });
});

test('checksum-aware resume skips intact chunks and re-downloads corrupt chunks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'massive-resume-')); let calls = 0;
  const options = { symbol: 'NVDA', from: '2024-01-01', to: '2024-01-14', directory, apiKey: 'unused', intervalMs: 0, request: async url => { calls++; return response([row(url.includes('01-08') ? 2 : 1)]); } };
  const first = await downloadArchive(options); assert.equal(calls, 2);
  await downloadArchive({ ...options, resume: true }); assert.equal(calls, 2);
  await writeFile(join(directory, first.chunks[1].file), '{corrupt}\n');
  await downloadArchive({ ...options, resume: true }); assert.equal(calls, 3);
});

test('offline archive validation detects checksum changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'massive-checksum-'));
  const manifest = await downloadArchive({ symbol: 'NVDA', from: '2024-01-01', to: '2024-01-01', directory, intervalMs: 0, request: async () => response([row(1)]) });
  await writeFile(join(directory, manifest.chunks[0].file), '{}\n');
  await assert.rejects(validateArchive(directory), /Checksum mismatch/);
});

test('offline validation rejects duplicate and out-of-order rows across chunks without deduplication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'massive-order-'));
  await assert.rejects(downloadArchive({ symbol: 'NVDA', from: '2024-01-01', to: '2024-01-08', directory, intervalMs: 0, request: async () => response([row(1)]) }), /duplicate or out-of-order/);
});

test('fractional volume and provider fields survive the persisted archive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'massive-fields-'));
  const wanted = row(1, { v: 0.000001, vw: 1.25, n: 7, otc: false });
  const manifest = await downloadArchive({ symbol: 'NVDA', from: '2024-01-01', to: '2024-01-01', directory, intervalMs: 0, request: async () => response([wanted]) });
  const stored = JSON.parse(await readFile(join(directory, manifest.chunks[0].file), 'utf8'));
  assert.deepEqual(stored.results[0], wanted);
});

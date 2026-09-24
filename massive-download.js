#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const API_ORIGIN = 'https://api.massive.com';
export const DEFAULT_INTERVAL_MS = 13_000;
export const DEFAULT_MAX_PAGES = 1_000;
export const DEFAULT_MAX_RETRIES = 4;
const DAY_MS = 86_400_000;
const SAFE_FIELDS = ['t', 'o', 'h', 'l', 'c', 'v', 'vw', 'n', 'otc'];

export const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
export const sha256 = data => createHash('sha256').update(data).digest('hex');

function isoDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error(`Invalid calendar date: ${value}`);
  return value;
}

export function calendarChunks(from, to) {
  const first = Date.parse(`${isoDay(from)}T00:00:00Z`), last = Date.parse(`${isoDay(to)}T00:00:00Z`);
  if (first > last) throw new Error('--from must not be after --to');
  const chunks = [];
  for (let start = first; start <= last; start += 7 * DAY_MS) {
    const end = Math.min(start + 6 * DAY_MS, last);
    chunks.push({ from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10) });
  }
  return chunks;
}

export function initialUrl(symbol, chunk) {
  const ticker = encodeURIComponent(symbol);
  return `${API_ORIGIN}/v2/aggs/ticker/${ticker}/range/1/minute/${chunk.from}/${chunk.to}?adjusted=true&sort=asc&limit=50000`;
}

function curlConfig(apiKey) {
  if (!apiKey || /[\r\n"\\]/.test(apiKey)) throw new Error('MASSIVE_API_KEY is missing or contains unsafe characters.');
  return `header = "Authorization: Bearer ${apiKey}"\n`;
}

export function curlRequest(url, apiKey, { spawnImpl = spawn } = {}) {
  const config = curlConfig(apiKey);
  return new Promise((resolvePromise, reject) => {
    const childEnv = { ...process.env }; delete childEnv.MASSIVE_API_KEY;
    const child = spawnImpl('curl', ['--silent', '--show-error', '--location', '--max-redirs', '0', '--config', '-', '--write-out', '\\n%{http_code}', url], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', value => stdout.push(value));
    child.stderr.on('data', value => stderr.push(value));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`curl transport failure (exit ${code}): ${Buffer.concat(stderr).toString('utf8').trim()}`));
      const output = Buffer.concat(stdout).toString('utf8'), split = output.lastIndexOf('\n');
      if (split < 0) return reject(new Error('curl did not return an HTTP status'));
      resolvePromise({ status: Number(output.slice(split + 1)), body: output.slice(0, split) });
    });
    child.stdin.end(config);
  });
}

export async function requestWithRetry(url, { request, wait = sleep, intervalMs = DEFAULT_INTERVAL_MS, maxRetries = DEFAULT_MAX_RETRIES, onRequest = () => {} }) {
  const maxAttempts = maxRetries + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (intervalMs) await wait(intervalMs);
    onRequest(url, attempt);
    let response;
    try {
      response = await request(url);
    } catch (error) {
      if (attempt + 1 >= maxAttempts) throw new Error(`Retry limit exhausted after network failure: ${error.message}`);
      continue;
    }
    if (response.status === 401 || response.status === 403) throw new Error(`Permanent authentication failure (HTTP ${response.status}).`);
    if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
      if (attempt + 1 >= maxAttempts) throw new Error(`Retry limit exhausted after HTTP ${response.status}.`);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Permanent HTTP ${response.status}.`);
    try {
      return JSON.parse(response.body);
    } catch {
      throw new Error('Malformed JSON in successful Massive response.');
    }
  }
  throw new Error('Retry limit exhausted.');
}

function validateEnvelope(page, expectedSymbol) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) throw new Error('Invalid Massive response envelope.');
  if (page.status != null && !['OK', 'DELAYED'].includes(String(page.status).toUpperCase())) throw new Error(`Unexpected Massive status: ${page.status}`);
  if (page.ticker != null && expectedSymbol && String(page.ticker).toUpperCase() !== String(expectedSymbol).toUpperCase()) throw new Error(`Ticker mismatch: expected ${expectedSymbol}, got ${page.ticker}`);
  if (page.adjusted != null && page.adjusted !== true) throw new Error('Massive response is not adjusted.');
  if (!Array.isArray(page.results)) throw new Error('Massive response is missing a results array.');
}

export async function collectChunk(firstUrl, options) {
  const seen = new Set(), results = [];
  let url = firstUrl, pages = 0;
  while (url) {
    const parsed = new URL(url);
    if (parsed.origin !== API_ORIGIN) throw new Error(`Refusing cross-origin pagination URL: ${parsed.origin}`);
    if (seen.has(parsed.href)) throw new Error('Pagination loop detected.');
    if (++pages > (options.maxPages ?? DEFAULT_MAX_PAGES)) throw new Error('Maximum page count exceeded.');
    seen.add(parsed.href);
    const page = await requestWithRetry(parsed.href, options);
    validateEnvelope(page, options.symbol);
    results.push(...page.results);
    url = page.next_url || null;
  }
  return { results, pages };
}

async function atomicWrite(path, data) {
  const part = `${path}.part`;
  await writeFile(part, data, { mode: 0o600 });
  await rename(part, path);
}

function validateRows(rows, context, previousTimestamp = null) {
  let previous = previousTimestamp;
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${context}: row ${index + 1} is not an object`);
    for (const field of ['t', 'o', 'h', 'l', 'c', 'v']) if (!Number.isFinite(row[field])) throw new Error(`${context}: row ${index + 1} has invalid ${field}`);
    if (!Number.isSafeInteger(row.t) || row.t < 0 || row.t % 60_000 !== 0) throw new Error(`${context}: row ${index + 1} has invalid or non-minute-aligned t`);
    if (row.v < 0) throw new Error(`${context}: row ${index + 1} has negative volume`);
    if (row.h < row.l || row.h < row.o || row.h < row.c || row.l > row.o || row.l > row.c) throw new Error(`${context}: row ${index + 1} has inconsistent OHLC`);
    if (row.vw != null && !Number.isFinite(row.vw)) throw new Error(`${context}: row ${index + 1} has invalid vw`);
    if (row.n != null && (!Number.isSafeInteger(row.n) || row.n < 0)) throw new Error(`${context}: row ${index + 1} has invalid n`);
    if (row.otc != null && typeof row.otc !== 'boolean') throw new Error(`${context}: row ${index + 1} has invalid otc`);
    if (previous !== null && row.t <= previous) throw new Error(`${context}: duplicate or out-of-order timestamp ${row.t}`);
    previous = row.t;
  });
  return previous;
}

function validateManifest(manifest, expected = null) {
  if (manifest.schemaVersion !== 1 || manifest.provider !== 'Massive' || manifest.multiplier !== 1 || manifest.timespan !== 'minute' || manifest.adjusted !== true || manifest.limit !== 50000 || !Array.isArray(manifest.chunks)) throw new Error('Invalid downloader manifest.');
  if (expected && (manifest.symbol !== expected.symbol || manifest.from !== expected.from || manifest.to !== expected.to)) throw new Error('Manifest does not match requested symbol/date range.');
  const planned = calendarChunks(manifest.from, manifest.to);
  if (planned.length !== manifest.chunks.length) throw new Error('Manifest chunk boundaries do not match requested range.');
  planned.forEach((chunk, i) => {
    if (manifest.chunks[i].from !== chunk.from || manifest.chunks[i].to !== chunk.to) throw new Error('Manifest chunk boundaries do not match requested range.');
  });
}

function validateStoredDocument(document, symbol, context) {
  validateEnvelope(document, symbol);
  validateRows(document.results, context);
}

export async function validateArchive(directory, expected = null) {
  const manifestPath = join(resolve(directory), 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  validateManifest(manifest, expected);
  let previous = null;
  for (const chunk of manifest.chunks) {
    const path = join(resolve(directory), chunk.file), bytes = await readFile(path);
    if (sha256(bytes) !== chunk.sha256) throw new Error(`Checksum mismatch: ${chunk.file}`);
    const document = JSON.parse(bytes.toString('utf8'));
    validateStoredDocument(document, manifest.symbol, chunk.file);
    previous = validateRows(document.results, chunk.file, previous);
    if (document.results.length !== chunk.rowCount) throw new Error(`${chunk.file}: row count differs from manifest`);
  }
  return { chunks: manifest.chunks.length, rows: manifest.chunks.reduce((sum, item) => sum + item.rowCount, 0) };
}

export async function downloadArchive({ symbol, from, to, directory, resume = false, apiKey, request, wait = sleep, intervalMs = DEFAULT_INTERVAL_MS, maxRetries = DEFAULT_MAX_RETRIES, maxPages = DEFAULT_MAX_PAGES }) {
  if (!symbol || !directory) throw new Error('symbol and directory are required');
  if (!apiKey && !request) throw new Error('MASSIVE_API_KEY is required.');
  const root = resolve(directory); await mkdir(root, { recursive: true, mode: 0o700 });
  const manifestPath = join(root, 'manifest.json');
  let old = null;
  if (resume) try { old = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const manifest = { schemaVersion: 1, provider: 'Massive', symbol, multiplier: 1, timespan: 'minute', adjusted: true, limit: 50000, from, to, chunks: [] };
  const requester = request || (url => curlRequest(url, apiKey));
  for (const chunk of calendarChunks(from, to)) {
    const file = `${symbol}-${chunk.from}-${chunk.to}-1m.json`, path = join(root, file);
    let prior = null;
    if (resume && old) {
      try {
        validateManifest(old, { symbol, from, to });
        prior = old.chunks.find(item => item.file === file && item.from === chunk.from && item.to === chunk.to);
      } catch {}
    }
    if (resume && prior) {
      try {
        const bytes = await readFile(path);
        if (sha256(bytes) === prior.sha256) {
          const document = JSON.parse(bytes.toString('utf8'));
          validateStoredDocument(document, symbol, file);
          if (document.results.length !== prior.rowCount) throw new Error('row count differs from manifest');
          manifest.chunks.push(prior);
          continue;
        }
      } catch {}
    }
    const collected = await collectChunk(initialUrl(symbol, chunk), { request: requester, wait, intervalMs, maxRetries, maxPages, symbol });
    validateRows(collected.results, file);
    const document = { ticker: symbol, adjusted: true, queryCount: collected.results.length, resultsCount: collected.results.length, results: collected.results };
    const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
    await atomicWrite(path, bytes);
    manifest.chunks.push({ ...chunk, file, rowCount: collected.results.length, pages: collected.pages, sha256: sha256(bytes) });
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await validateArchive(root, { symbol, from, to });
  return manifest;
}

function args(argv) {
  const command = argv.shift(), result = { command, resume: false };
  while (argv.length) { const key = argv.shift(); if (key === '--resume') result.resume = true; else { if (!key.startsWith('--') || !argv.length) throw new Error('Invalid arguments.'); result[key.slice(2)] = argv.shift(); } }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const options = args([...argv]);
  if (options.command === 'validate' && options.directory) return console.log(JSON.stringify(await validateArchive(options.directory)));
  if (options.command !== 'download' || !options.symbol || !options.from || !options.to || !options.directory) throw new Error('Usage: massive-download.js download --symbol NVDA --from YYYY-MM-DD --to YYYY-MM-DD --directory DIR [--resume]\n       massive-download.js validate --directory DIR');
  const manifest = await downloadArchive({ ...options, apiKey: process.env.MASSIVE_API_KEY });
  console.log(`Completed ${manifest.chunks.length} chunk(s) in ${resolve(options.directory)}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });

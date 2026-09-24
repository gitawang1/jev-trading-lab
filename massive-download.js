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
  let attempt = 0;
  while (true) {
    if (intervalMs) await wait(intervalMs);
    onRequest(url, attempt);
    try {
      const response = await request(url);
      if (response.status === 401 || response.status === 403) throw Object.assign(new Error(`Permanent authentication failure (HTTP ${response.status}).`), { permanent: true });
      if (response.status === 429 || response.status >= 500) {
        if (attempt++ < maxRetries) continue;
        throw new Error(`Retry limit exhausted after HTTP ${response.status}.`);
      }
      if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`Permanent HTTP ${response.status}.`), { permanent: true });
      return JSON.parse(response.body);
    } catch (error) {
      if (error.permanent || error instanceof SyntaxError) throw error;
      if (attempt++ >= maxRetries) throw new Error(`Retry limit exhausted after network failure: ${error.message}`);
    }
  }
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
    if (!Array.isArray(page.results)) throw new Error('Massive response is missing a results array.');
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
    if (!Number.isSafeInteger(row.t)) throw new Error(`${context}: row ${index + 1} has invalid t`);
    for (const field of ['vw', 'n']) if (row[field] != null && !Number.isFinite(row[field])) throw new Error(`${context}: row ${index + 1} has invalid ${field}`);
    if (previous !== null && row.t <= previous) throw new Error(`${context}: duplicate or out-of-order timestamp ${row.t}`);
    previous = row.t;
  });
  return previous;
}

export async function validateArchive(directory) {
  const manifestPath = join(resolve(directory), 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.chunks)) throw new Error('Invalid downloader manifest.');
  let previous = null;
  for (const chunk of manifest.chunks) {
    const path = join(resolve(directory), chunk.file), bytes = await readFile(path);
    if (sha256(bytes) !== chunk.sha256) throw new Error(`Checksum mismatch: ${chunk.file}`);
    const document = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(document.results)) throw new Error(`${chunk.file}: missing results array`);
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
    const prior = old?.symbol === symbol && old?.from === from && old?.to === to && old.chunks?.find(item => item.file === file);
    if (resume && prior) {
      try { const bytes = await readFile(path); if (sha256(bytes) === prior.sha256) { manifest.chunks.push(prior); continue; } } catch {}
    }
    const collected = await collectChunk(initialUrl(symbol, chunk), { request: requester, wait, intervalMs, maxRetries, maxPages });
    validateRows(collected.results, file);
    const document = { ticker: symbol, adjusted: true, queryCount: collected.results.length, resultsCount: collected.results.length, results: collected.results };
    const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
    await atomicWrite(path, bytes);
    manifest.chunks.push({ ...chunk, file, rowCount: collected.results.length, pages: collected.pages, sha256: sha256(bytes) });
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await validateArchive(root);
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

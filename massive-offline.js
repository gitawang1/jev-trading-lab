import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_EXCHANGE_TIMEZONE = 'America/New_York';
export const MINUTE_MS = 60_000;

const sessionBounds = {
  rth: { start: 9 * 60 + 30, end: 16 * 60 },
  extended: { start: 4 * 60, end: 20 * 60 },
};

function localParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, Number(value)]));
}

function sessionPosition(timestamp, timeZone, sessionMode) {
  const bounds = sessionBounds[sessionMode];
  if (!bounds) throw new Error('--session must be rth or extended.');
  const p = localParts(timestamp, timeZone);
  const minute = p.hour * 60 + p.minute;
  const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return { ...bounds, date, minute, eligible: minute >= bounds.start && minute < bounds.end };
}

function bucketFor(timestamp, timeZone, sessionMode) {
  const session = sessionPosition(timestamp, timeZone, sessionMode);
  if (!session.eligible) return null;
  const offset = Math.floor((session.minute - session.start) / 5) * 5;
  const bucketOpen = timestamp - ((session.minute - session.start) - offset) * MINUTE_MS;
  return { key: `${session.date}:${offset}`, bucketOpen, date: session.date };
}

function rowTimestamp(row) {
  return typeof row === 'object' && row !== null && typeof row.t === 'number' ? row.t : NaN;
}

function normalizeRow(row, symbol) {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new Error('row is not an object');
  const t = row.t;
  if (!Number.isSafeInteger(t)) throw new Error('t must be a Unix-millisecond safe integer');
  if (!Number.isFinite(new Date(t).getTime())) throw new Error('t is outside the supported date range');
  if (t % MINUTE_MS !== 0) throw new Error('t is not exactly minute-aligned');
  const values = Object.fromEntries(['o', 'h', 'l', 'c', 'v'].map(key => [key, row[key]]));
  if (Object.values(values).some(value => !Number.isFinite(value))) throw new Error('OHLCV contains a missing or non-finite value');
  if (values.v < 0) throw new Error('volume is negative');
  if (values.h < Math.max(values.o, values.l, values.c) || values.l > Math.min(values.o, values.h, values.c)) throw new Error('invalid OHLC relationship');
  const providerVwap = row.vw == null ? null : row.vw;
  if (providerVwap !== null && !Number.isFinite(providerVwap)) throw new Error('provider VWAP is non-finite');
  const transactionCount = row.n == null ? null : row.n;
  if (transactionCount !== null && (!Number.isSafeInteger(transactionCount) || transactionCount < 0)) throw new Error('transaction count is invalid');
  return { symbol, barOpen: t, barClose: t + MINUTE_MS, open: values.o, high: values.h, low: values.l, close: values.c, volume: values.v, providerVwap, transactionCount };
}

export function parseMassiveJson(text, symbolOverride) {
  const document = JSON.parse(text);
  const rows = Array.isArray(document) ? document : document?.results;
  if (!Array.isArray(rows)) throw new Error('Input JSON must be an array or an object with a results array.');
  const symbol = symbolOverride || (!Array.isArray(document) && (document.ticker || document.symbol)) || 'NVDA';
  return { rows, symbol };
}

export function ingestAndAggregate(rows, { symbol = 'NVDA', exchangeTimezone = DEFAULT_EXCHANGE_TIMEZONE, sessionMode = 'rth' } = {}) {
  if (!sessionBounds[sessionMode]) throw new Error('sessionMode must be rth or extended');
  const malformedRows = [], outOfOrder = [], normalized = [], bucketIssues = new Map();
  let previousTimestamp = null;
  const touchIssue = (bucket, detail) => {
    if (!bucketIssues.has(bucket.key)) bucketIssues.set(bucket.key, { ...bucket, reasons: [] });
    bucketIssues.get(bucket.key).reasons.push(detail);
  };
  rows.forEach((row, index) => {
    const rawTimestamp = rowTimestamp(row);
    try {
      const bar = normalizeRow(row, symbol);
      if (previousTimestamp !== null && bar.barOpen < previousTimestamp) outOfOrder.push({ row: index + 1, timestamp: bar.barOpen, previousTimestamp });
      previousTimestamp = bar.barOpen;
      normalized.push({ ...bar, sourceRow: index + 1 });
    } catch (error) {
      malformedRows.push({ row: index + 1, timestamp: Number.isFinite(rawTimestamp) ? rawTimestamp : null, reason: error.message });
      if (Number.isSafeInteger(rawTimestamp) && Number.isFinite(new Date(rawTimestamp).getTime())) {
        const bucket = bucketFor(rawTimestamp - (rawTimestamp % MINUTE_MS), exchangeTimezone, sessionMode);
        if (bucket) touchIssue(bucket, `malformed source row ${index + 1} (${error.message})`);
      }
    }
  });

  const ordered = [...normalized].sort((a, b) => a.barOpen - b.barOpen || a.sourceRow - b.sourceRow);
  const byTimestamp = new Map();
  for (const bar of ordered) {
    if (!byTimestamp.has(bar.barOpen)) byTimestamp.set(bar.barOpen, []);
    byTimestamp.get(bar.barOpen).push(bar);
  }
  const duplicates = [];
  for (const [timestamp, occurrences] of byTimestamp) {
    if (occurrences.length > 1) {
      duplicates.push({ timestamp, rows: occurrences.map(bar => bar.sourceRow) });
      const bucket = bucketFor(timestamp, exchangeTimezone, sessionMode);
      if (bucket) touchIssue(bucket, `duplicate timestamp ${new Date(timestamp).toISOString()} in rows ${occurrences.map(bar => bar.sourceRow).join(', ')}`);
    }
  }

  const sessionBars = ordered.filter(bar => sessionPosition(bar.barOpen, exchangeTimezone, sessionMode).eligible);
  const excludedSessionRows = ordered.filter(bar => !sessionPosition(bar.barOpen, exchangeTimezone, sessionMode).eligible);
  const buckets = new Map();
  for (const bar of sessionBars) {
    const bucket = bucketFor(bar.barOpen, exchangeTimezone, sessionMode);
    if (!buckets.has(bucket.key)) buckets.set(bucket.key, { ...bucket, bars: [] });
    buckets.get(bucket.key).bars.push(bar);
  }
  for (const issue of bucketIssues.values()) if (!buckets.has(issue.key)) buckets.set(issue.key, { ...issue, bars: [] });

  const cleanBars = [], omittedBuckets = [];
  for (const bucket of [...buckets.values()].sort((a, b) => a.bucketOpen - b.bucketOpen)) {
    const expected = Array.from({ length: 5 }, (_, i) => bucket.bucketOpen + i * MINUTE_MS);
    const unique = new Map(bucket.bars.map(bar => [bar.barOpen, bar]));
    const missing = expected.filter(timestamp => !unique.has(timestamp));
    const reasons = [...(bucketIssues.get(bucket.key)?.reasons || [])];
    if (bucket.bars.length !== 5 || unique.size !== 5 || missing.length || reasons.length) {
      if (missing.length) reasons.push(`missing expected minute(s): ${missing.map(value => new Date(value).toISOString()).join(', ')}`);
      omittedBuckets.push({ bucketOpen: bucket.bucketOpen, missing, reasons });
      continue;
    }
    const constituents = expected.map(timestamp => unique.get(timestamp));
    const volume = constituents.reduce((sum, bar) => sum + bar.volume, 0);
    const allVwap = constituents.every(bar => bar.providerVwap !== null && Number.isFinite(bar.volume));
    const providerVwap = allVwap && volume > 0 ? constituents.reduce((sum, bar) => sum + bar.providerVwap * bar.volume, 0) / volume : null;
    const allCounts = constituents.every(bar => bar.transactionCount !== null);
    cleanBars.push({ symbol, barOpen: bucket.bucketOpen, barClose: bucket.bucketOpen + 5 * MINUTE_MS, open: constituents[0].open, high: Math.max(...constituents.map(bar => bar.high)), low: Math.min(...constituents.map(bar => bar.low)), close: constituents[4].close, volume, providerVwap, transactionCount: allCounts ? constituents.reduce((sum, bar) => sum + bar.transactionCount, 0) : null });
  }
  return { sourceRowCount: rows.length, normalized, malformedRows, duplicates, outOfOrder, sessionBars, excludedSessionRows, cleanBars, omittedBuckets, sessionMode, exchangeTimezone };
}

export function cleanCsv(cleanBars) {
  return ['timestamp,open,high,low,close,volume', ...cleanBars.map(bar => [new Date(bar.barOpen).toISOString(), bar.open, bar.high, bar.low, bar.close, bar.volume].join(','))].join('\n') + '\n';
}

function timestampRange(rows, property) {
  if (!rows.length) return 'n/a';
  return `${new Date(rows[0][property]).toISOString()} through ${new Date(rows.at(-1)[property]).toISOString()}`;
}

export function integrityReport(result, source) {
  const missing = result.omittedBuckets.flatMap(bucket => bucket.missing);
  const stamp = value => Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : String(value);
  return [
    'Massive 1-minute offline ingestion integrity report',
    `Source: ${source}`,
    `Source row count: ${result.sourceRowCount}`,
    `Valid normalized 1-minute rows: ${result.normalized.length}`,
    `Malformed rows: ${result.malformedRows.length}`,
    ...result.malformedRows.map(item => `  row ${item.row}${item.timestamp === null ? '' : ` (${stamp(item.timestamp)})`}: ${item.reason}`),
    `Duplicate timestamps: ${result.duplicates.length}`,
    ...result.duplicates.map(item => `  ${new Date(item.timestamp).toISOString()}: source rows ${item.rows.join(', ')}`),
    `Out-of-order timestamps: ${result.outOfOrder.length}`,
    ...result.outOfOrder.map(item => `  row ${item.row}: ${new Date(item.timestamp).toISOString()} follows ${new Date(item.previousTimestamp).toISOString()}`),
    `Session-filtered rows (retained): ${result.sessionBars.length}`,
    `Outside-session rows (excluded): ${result.excludedSessionRows.length}`,
    ...result.excludedSessionRows.map(item => `  row ${item.sourceRow}: ${new Date(item.barOpen).toISOString()}`),
    `Complete 5-minute buckets: ${result.cleanBars.length}`,
    `Incomplete/omitted 5-minute buckets: ${result.omittedBuckets.length}`,
    ...result.omittedBuckets.map(item => `  ${new Date(item.bucketOpen).toISOString()}: ${item.reasons.join('; ')}`),
    `Missing expected minute timestamps: ${missing.length}`,
    ...missing.map(item => `  ${new Date(item).toISOString()}`),
    `First/last normalized timestamp: ${timestampRange([...result.normalized].sort((a, b) => a.barOpen - b.barOpen), 'barOpen')}`,
    `First/last clean 5-minute timestamp: ${timestampRange(result.cleanBars, 'barOpen')}`,
    `Session mode: ${result.sessionMode.toUpperCase()}`,
    `Exchange timezone: ${result.exchangeTimezone}`,
  ].join('\n') + '\n';
}

function usage() {
  return 'Usage: node massive-offline.js convert --input raw.json --output clean-5m.csv --report integrity.txt [--symbol NVDA] [--session rth|extended] [--exchange-timezone America/New_York]';
}

function parseArgs(argv) {
  const command = argv[0], options = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] == null) throw new Error(usage());
    options[argv[i].slice(2)] = argv[i + 1];
  }
  return { command, ...options };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.command !== 'convert' || !args.input || !args.output || !args.report) throw new Error(usage());
  const paths = [args.input, args.output, args.report].map(value => resolve(value));
  if (new Set(paths).size !== paths.length) throw new Error('Input, output CSV, and integrity report must use three different paths; the raw input is never overwritten.');
  const { rows, symbol } = parseMassiveJson(await readFile(args.input, 'utf8'), args.symbol);
  const result = ingestAndAggregate(rows, { symbol, sessionMode: args.session || 'rth', exchangeTimezone: args['exchange-timezone'] || DEFAULT_EXCHANGE_TIMEZONE });
  await writeFile(args.output, cleanCsv(result.cleanBars));
  await writeFile(args.report, integrityReport(result, args.input));
  console.log(`Wrote ${result.cleanBars.length} clean bars to ${args.output}; ${result.omittedBuckets.length} bucket(s) omitted. See ${args.report}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });

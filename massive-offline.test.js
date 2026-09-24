import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanCsv, ingestAndAggregate, integrityReport, parseMassiveJson } from './massive-offline.js';

const minute = 60_000;
const janOpen = Date.parse('2024-01-02T14:30:00.000Z'); // 09:30 America/New_York
const raw = (t, overrides = {}) => ({ t, o: 100, h: 102, l: 99, c: 101, v: 1, vw: 100.5, n: 10, ...overrides });
const five = (start = janOpen, overrides = {}) => Array.from({ length: 5 }, (_, i) => raw(start + i * minute, typeof overrides === 'function' ? overrides(i) : overrides));
const aggregate = (rows, options) => ingestAndAggregate(rows, options);

test('exactly five consecutive BAR OPEN records make one correctly stamped OHLCV bar', () => {
  const result = aggregate(five(janOpen, i => ({ o: 100 + i, h: 105 + i, l: 95 + i, c: 101 + i, v: i + 0.25 })));
  assert.equal(result.cleanBars.length, 1);
  assert.deepEqual(result.cleanBars[0], {
    symbol: 'NVDA', barOpen: janOpen, barClose: janOpen + 5 * minute,
    open: 100, high: 109, low: 95, close: 105, volume: 11.25,
    providerVwap: 100.5, transactionCount: 50,
  });
  assert.match(cleanCsv(result.cleanBars), /^timestamp,open,high,low,close,volume\n2024-01-02T14:30:00\.000Z,/);
});

test('a missing middle minute omits and itemizes its bucket', () => {
  const rows = five(); rows.splice(2, 1);
  const result = aggregate(rows);
  assert.equal(result.cleanBars.length, 0);
  assert.deepEqual(result.omittedBuckets[0].missing, [janOpen + 2 * minute]);
  assert.match(integrityReport(result, 'fixture'), /2024-01-02T14:32:00\.000Z/);
});

test('a duplicate timestamp poisons rather than silently deduplicates its bucket', () => {
  const rows = five(); rows.push({ ...rows[2] });
  const result = aggregate(rows);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.cleanBars.length, 0);
  assert.match(result.omittedBuckets[0].reasons.join(' '), /duplicate timestamp/);
});

test('out-of-order input is reported but deterministic sorting produces the same clean bar', () => {
  const ordered = five(); const shuffled = [ordered[2], ordered[0], ordered[1], ordered[4], ordered[3]];
  const result = aggregate(shuffled);
  assert.ok(result.outOfOrder.length > 0);
  assert.deepEqual(result.cleanBars, aggregate(ordered).cleanBars);
});

test('fractional volumes are preserved and summed without integer rounding', () => {
  const result = aggregate(five(janOpen, { v: 0.123456 }));
  assert.ok(Math.abs(result.cleanBars[0].volume - 0.61728) < Number.EPSILON);
  assert.notEqual(result.cleanBars[0].volume, 0);
  assert.match(cleanCsv(result.cleanBars), /,0\.61727/);
});

test('RTH excludes 09:29 and 16:00 while including 09:30 and 15:59', () => {
  const rows = [raw(janOpen - minute), raw(janOpen), raw(Date.parse('2024-01-02T20:59:00Z')), raw(Date.parse('2024-01-02T21:00:00Z'))];
  const result = aggregate(rows);
  assert.deepEqual(result.sessionBars.map(bar => bar.barOpen), [janOpen, Date.parse('2024-01-02T20:59:00Z')]);
});

test('extended session includes 04:00 and excludes 20:00', () => {
  const start = Date.parse('2024-01-02T09:00:00Z'), end = Date.parse('2024-01-03T01:00:00Z');
  const result = aggregate([raw(start), raw(end)], { sessionMode: 'extended' });
  assert.deepEqual(result.sessionBars.map(bar => bar.barOpen), [start]);
});

test('America/New_York conversion is DST-aware', () => {
  const winter = five(Date.parse('2024-01-02T14:30:00Z'));
  const summer = five(Date.parse('2024-07-02T13:30:00Z'));
  const result = aggregate([...winter, ...summer]);
  assert.deepEqual(result.cleanBars.map(bar => new Date(bar.barOpen).toISOString()), ['2024-01-02T14:30:00.000Z', '2024-07-02T13:30:00.000Z']);
});

test('provider t and output timestamp both remain BAR OPEN timestamps', () => {
  const providerExample = 1789977600000;
  const result = aggregate(five(providerExample), { sessionMode: 'extended' });
  assert.equal(result.normalized[0].barOpen, providerExample);
  assert.equal(result.normalized[0].barClose, providerExample + minute);
  assert.equal(result.cleanBars[0].barOpen, providerExample);
  assert.match(cleanCsv(result.cleanBars), /2026-09-21T08:00:00\.000Z/);
});

test('malformed and non-finite OHLCV are rejected, reported, and poison their known bucket', () => {
  const rows = five(); rows[1] = raw(janOpen + minute, { h: Number.NaN });
  const result = aggregate(rows);
  assert.equal(result.malformedRows.length, 1);
  assert.equal(result.cleanBars.length, 0);
  assert.match(integrityReport(result, 'fixture'), /OHLCV contains a missing or non-finite value/);
});

test('bars never form a bucket across session days', () => {
  const dayOne = five(janOpen).slice(0, 3);
  const dayTwo = five(Date.parse('2024-01-03T14:30:00Z')).slice(3);
  const result = aggregate([...dayOne, ...dayTwo]);
  assert.equal(result.cleanBars.length, 0);
  assert.equal(result.omittedBuckets.length, 2);
});

test('provider VWAP is volume weighted only when all five values exist', () => {
  const complete = aggregate(five(janOpen, i => ({ v: i + 1, vw: 100 + i })));
  assert.equal(complete.cleanBars[0].providerVwap, 102.66666666666667);
  assert.equal(complete.cleanBars[0].transactionCount, 50);
  const missing = five(); delete missing[2].vw; delete missing[3].n;
  const result = aggregate(missing);
  assert.equal(result.cleanBars[0].providerVwap, null);
  assert.equal(result.cleanBars[0].transactionCount, null);
});

test('JSON accepts a Massive results envelope or normalized top-level array', () => {
  assert.equal(parseMassiveJson(JSON.stringify({ ticker: 'NVDA', results: five() })).rows.length, 5);
  assert.equal(parseMassiveJson(JSON.stringify(five()), 'TEST').symbol, 'TEST');
});

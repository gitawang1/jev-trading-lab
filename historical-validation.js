import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const BAR_MS = 5 * 60_000;
export const OUTCOME_FIELDS = ['forwardReturn5m', 'forwardReturn15m', 'forwardReturn30m', 'forwardReturn60m', 'MFE15m', 'MAE15m', 'MFE30m', 'MAE30m', 'MFE60m', 'MAE60m'];
export const JEV_FIELDS = ['timestamp', 'symbol', 'price', 'crsi', 'relative_volume', 'above_VWAP', 'distance_from_VWAP_percent', 'five_minute_swing_high_broken', 'trend_1h', 'trend_4h'];

const zonedPartsCache = new Map();
function zonedParts(ms, zone) {
  const cacheKey = `${zone}:${ms}`; if (zonedPartsCache.has(cacheKey)) return zonedPartsCache.get(cacheKey);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const result = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)])); zonedPartsCache.set(cacheKey, result); return result;
}

export function localToInstant(text, zone) {
  const match = text.trim().match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?$/);
  if (!match) throw new Error(`Timestamp without offset is not ISO local date/time: ${text}`);
  const wanted = { year: +match[1], month: +match[2], day: +match[3], hour: +match[4], minute: +match[5], second: +(match[6] || 0) };
  const fractional = +(match[7] || '').padEnd(3, '0');
  const nominal = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute, wanted.second, fractional);
  let guess = nominal;
  for (let i = 0; i < 4; i++) {
    const got = zonedParts(guess, zone);
    const represented = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second, fractional);
    guess += nominal - represented;
  }
  const check = zonedParts(guess, zone);
  if (Object.keys(wanted).some(key => check[key] !== wanted[key])) throw new Error(`Nonexistent or ambiguous local timestamp: ${text} (${zone})`);
  return guess;
}

export function parseTimestamp(text, inputTimezone) {
  if (/[zZ]$|[+-]\d\d(?::?\d\d)?$/.test(text.trim())) {
    const value = Date.parse(text);
    if (!Number.isFinite(value)) throw new Error(`Invalid timestamp: ${text}`);
    return value;
  }
  if (!inputTimezone) throw new Error('A timestamp without an offset requires --input-timezone.');
  return localToInstant(text, inputTimezone);
}

function parseCsvLine(line) {
  const values = []; let value = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { values.push(value); value = ''; }
    else value += c;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  values.push(value); return values;
}

export function parseHistoricalCsv(text, { timestampSemantics, inputTimezone }) {
  if (!['open', 'close'].includes(timestampSemantics)) throw new Error('--timestamp-semantics must be open or close.');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/); const headerLine = lines.shift();
  if (!headerLine) throw new Error('CSV is empty.');
  const headers = parseCsvLine(headerLine).map(x => x.trim().toLowerCase());
  const required = ['timestamp', 'open', 'high', 'low', 'close', 'volume'];
  const indexes = Object.fromEntries(required.map(name => [name, headers.indexOf(name)]));
  const missing = required.filter(name => indexes[name] < 0); if (missing.length) throw new Error(`Missing CSV columns: ${missing.join(', ')}`);
  const bars = []; const invalidRows = []; const seen = new Set();
  lines.forEach((line, offset) => {
    if (!line.trim()) return;
    try {
      const cells = parseCsvLine(line); const stamp = parseTimestamp(cells[indexes.timestamp], inputTimezone);
      const numbers = Object.fromEntries(required.slice(1).map(name => [name, Number(cells[indexes[name]])]));
      if (Object.values(numbers).some(x => !Number.isFinite(x)) || numbers.volume < 0 || numbers.high < Math.max(numbers.open, numbers.close, numbers.low) || numbers.low > Math.min(numbers.open, numbers.close, numbers.high)) throw new Error('invalid OHLCV');
      const barOpen = timestampSemantics === 'open' ? stamp : stamp - BAR_MS; const barClose = barOpen + BAR_MS;
      if (seen.has(barClose)) throw new Error('duplicate normalized timestamp'); seen.add(barClose);
      bars.push({ ...numbers, barOpen, barClose });
    } catch (error) { invalidRows.push({ row: offset + 2, reason: error.message }); }
  });
  bars.sort((a, b) => a.barOpen - b.barOpen); return { bars, invalidRows };
}

export function sessionInfo(ms, zone, mode) {
  const p = zonedParts(ms, zone); const minute = p.hour * 60 + p.minute;
  const [start, end] = mode === 'regular' ? [570, 960] : [240, 1200];
  return { eligible: minute >= start && minute < end, key: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`, minute, start, end };
}

export function wilderRsi(values, period) {
  if (values.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; gain += Math.max(d, 0); loss += Math.max(-d, 0); }
  gain /= period; loss /= period;
  for (let i = period + 1; i < values.length; i++) { const d = values[i] - values[i - 1]; gain = (gain * (period - 1) + Math.max(d, 0)) / period; loss = (loss * (period - 1) + Math.max(-d, 0)) / period; }
  if (loss === 0) return gain === 0 ? 50 : 100; if (gain === 0) return 0; return 100 - 100 / (1 + gain / loss);
}

export function percentRank100(window) {
  if (window.length !== 100) return null; const current = window.at(-1);
  const lower = window.filter(x => x < current).length; const ties = window.filter(x => x === current).length;
  return lower + ties / 2;
}

export function relativeVolume20(sessionBars, currentVolume) {
  const prior = sessionBars.slice(-20); return prior.length === 20 ? currentVolume / (prior.reduce((sum, bar) => sum + bar.volume, 0) / 20) : null;
}

export function previousFiveBarHigh(sessionBars) {
  const prior = sessionBars.slice(-5); return prior.length === 5 ? Math.max(...prior.map(bar => bar.high)) : null;
}

export function accumulateVwap(state, bar) {
  const typical = (bar.high + bar.low + bar.close) / 3; const volumePrice = state.volumePrice + typical * bar.volume; const volume = state.volume + bar.volume;
  return { volumePrice, volume, value: volume ? volumePrice / volume : null };
}

function ema(values, period) { if (!values.length) return null; const k = 2 / (period + 1); let result = values[0]; for (const v of values.slice(1)) result = v * k + result * (1 - k); return result; }
function trend(closes) { if (closes.length < 50) return null; const close = closes.at(-1), e20 = ema(closes, 20), e50 = ema(closes, 50); return close > e20 && e20 > e50 ? 1 : close < e20 && e20 < e50 ? -1 : 0; }

function higherTrendMap(bars, minutes, zone, mode) {
  const result = new Map(), completed = []; let key = null, bucketBars = [], endMinute = null, sessionEnd = null;
  for (const bar of bars) {
    const s = sessionInfo(bar.barOpen, zone, mode); const bucket = Math.floor((s.minute - s.start) / minutes); const nextKey = `${s.key}:${bucket}`;
    if (nextKey !== key) { key = nextKey; bucketBars = []; endMinute = s.start + (bucket + 1) * minutes; sessionEnd = s.end; }
    bucketBars.push(bar);
    if (endMinute <= sessionEnd && bucketBars.length === minutes / 5 && bucketBars.every((x, i, a) => i === 0 || x.barOpen - a[i - 1].barOpen === BAR_MS)) completed.push(bucketBars.at(-1).close);
    result.set(bar.barClose, trend(completed));
  }
  return result;
}

export function completedHigherBars(bars, uptoClose, minutes, zone, mode) {
  const size = minutes / 5; const buckets = new Map();
  for (const bar of bars) {
    if (bar.barClose > uptoClose) break; const s = sessionInfo(bar.barOpen, zone, mode); if (!s.eligible) continue;
    const bucket = Math.floor((s.minute - s.start) / minutes); const key = `${s.key}:${bucket}`;
    if (!buckets.has(key)) buckets.set(key, { bars: [], endMinute: s.start + (bucket + 1) * minutes, sessionEnd: s.end });
    buckets.get(key).bars.push(bar);
  }
  return [...buckets.values()].filter(b => b.endMinute <= b.sessionEnd && b.bars.length === size && b.bars.every((x, i, a) => i === 0 || x.barOpen - a[i - 1].barOpen === BAR_MS) && b.bars.at(-1).barClose <= uptoClose).map(b => b.bars.at(-1).close);
}

export function toJevSafe(feature) { return Object.fromEntries(JEV_FIELDS.map(name => [name, feature[name]])); }

export function buildHistoricalValidation(allBars, { symbol = 'NVDA', exchangeTimezone = 'America/New_York', sessionMode = 'regular' } = {}) {
  if (!['regular', 'extended'].includes(sessionMode)) throw new Error('session mode must be regular or extended');
  const bars = allBars.filter(b => sessionInfo(b.barOpen, exchangeTimezone, sessionMode).eligible);
  const trends1h = higherTrendMap(bars, 60, exchangeTimezone, sessionMode), trends4h = higherTrendMap(bars, 240, exchangeTimezone, sessionMode);
  const closes = [], streaks = [], returns = []; let streak = 0; let currentSession; let sessionBars = []; let pv = 0, pvv = 0;
  const candidates = []; const exclusion = { insufficientCrsiHistory: 0, insufficientRelativeVolumeHistory: 0, insufficientPreviousFiveHistory: 0, insufficient1hHistory: 0, insufficient4hHistory: 0, insufficientFutureBars: 0 };
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], s = sessionInfo(b.barOpen, exchangeTimezone, sessionMode);
    if (s.key !== currentSession) { currentSession = s.key; sessionBars = []; pv = 0; pvv = 0; }
    const previous = closes.at(-1); streak = previous == null || b.close === previous ? 0 : b.close > previous ? Math.max(streak, 0) + 1 : Math.min(streak, 0) - 1;
    closes.push(b.close); streaks.push(streak); if (previous != null) returns.push((b.close / previous - 1) * 100);
    const priceRsi = wilderRsi(closes, 3), streakRsi = wilderRsi(streaks, 2), rank = percentRank100(returns.slice(-100));
    const crsi = priceRsi == null || streakRsi == null || rank == null ? null : (priceRsi + streakRsi + rank) / 3;
    const relativeVolume = relativeVolume20(sessionBars, b.volume);
    const previous5BarHigh = previousFiveBarHigh(sessionBars);
    const accumulated = accumulateVwap({ volumePrice: pv, volume: pvv }, b); pv = accumulated.volumePrice; pvv = accumulated.volume; const vwap = accumulated.value;
    const trend1h = trends1h.get(b.barClose), trend4h = trends4h.get(b.barClose);
    const missing = [crsi == null, relativeVolume == null, previous5BarHigh == null, trend1h == null, trend4h == null];
    const keys = Object.keys(exclusion).slice(0, 5); missing.forEach((x, j) => { if (x) exclusion[keys[j]]++; });
    const observationId = `${symbol}-${new Date(b.barClose).toISOString()}`;
    candidates.push({ b, feature: { observation_id: observationId, timestamp: new Date(b.barClose).toISOString(), symbol, price: b.close, crsi, relative_volume: relativeVolume, above_VWAP: b.close > vwap ? 1 : 0, distance_from_VWAP_percent: ((b.close - vwap) / vwap) * 100, five_minute_swing_high_broken: previous5BarHigh == null ? null : b.close > previous5BarHigh ? 1 : 0, trend_1h: trend1h, trend_4h: trend4h }, diagnostic: { priceRsi, streak, streakRsi, oneBarReturn: returns.at(-1) ?? null, percentRank100: rank, crsi } });
    sessionBars.push(b);
  }
  const features = [], outcomes = [], diagnostics = new Map();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]; if (JEV_FIELDS.some(k => c.feature[k] == null)) continue;
    const future = n => candidates[i + n]?.b.barOpen - c.b.barOpen === n * BAR_MS && sessionInfo(candidates[i + n].b.barOpen, exchangeTimezone, sessionMode).key === sessionInfo(c.b.barOpen, exchangeTimezone, sessionMode).key ? candidates[i + n].b : null;
    const targets = [1, 3, 6, 12].map(future); if (targets.some(x => !x)) { exclusion.insufficientFutureBars++; continue; }
    const excursion = n => Array.from({ length: n }, (_, j) => future(j + 1));
    const groups = [3, 6, 12].map(excursion); if (groups.some(g => g.some(x => !x))) { exclusion.insufficientFutureBars++; continue; }
    const pct = x => (x / c.b.close - 1) * 100;
    features.push(c.feature); outcomes.push({ observation_id: c.feature.observation_id, timestamp: c.feature.timestamp, forwardReturn5m: pct(targets[0].close), forwardReturn15m: pct(targets[1].close), forwardReturn30m: pct(targets[2].close), forwardReturn60m: pct(targets[3].close), MFE15m: pct(Math.max(...groups[0].map(x => x.high))), MAE15m: pct(Math.min(...groups[0].map(x => x.low))), MFE30m: pct(Math.max(...groups[1].map(x => x.high))), MAE30m: pct(Math.min(...groups[1].map(x => x.low))), MFE60m: pct(Math.max(...groups[2].map(x => x.high))), MAE60m: pct(Math.min(...groups[2].map(x => x.low))) });
    diagnostics.set(c.feature.observation_id, c.diagnostic); diagnostics.set(c.feature.timestamp, c.diagnostic);
  }
  return { features, outcomes, diagnostics, exclusion, eligibleBarCount: bars.length };
}

function csv(rows, columns) { const encode = v => { const s = v == null ? '' : typeof v === 'number' ? Number(v.toFixed(10)).toString() : String(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }; return [columns.join(','), ...rows.map(r => columns.map(c => encode(r[c])).join(','))].join('\n') + '\n'; }
function usage() { return 'Usage: node historical-validation.js generate --input bars.csv --timestamp-semantics open|close [--input-timezone IANA] [--exchange-timezone America/New_York] [--session regular|extended] [--symbol NVDA]\n       node historical-validation.js diagnostic --input bars.csv ... (--timestamp ISO|--observation-id ID)'; }
function args(argv) { const result = { command: argv[0] }; for (let i = 1; i < argv.length; i += 2) { if (!argv[i].startsWith('--') || argv[i + 1] == null) throw new Error(usage()); result[argv[i].slice(2)] = argv[i + 1]; } return result; }

export async function main(argv = process.argv.slice(2)) {
  const a = args(argv); if (!['generate', 'diagnostic'].includes(a.command) || !a.input) throw new Error(usage());
  const parsed = parseHistoricalCsv(await readFile(a.input, 'utf8'), { timestampSemantics: a['timestamp-semantics'], inputTimezone: a['input-timezone'] });
  const options = { symbol: a.symbol || 'NVDA', exchangeTimezone: a['exchange-timezone'] || 'America/New_York', sessionMode: a.session || 'regular' };
  const built = buildHistoricalValidation(parsed.bars, options);
  if (a.command === 'diagnostic') { const key = a.timestamp || a['observation-id']; const d = built.diagnostics.get(key); if (!d) throw new Error('No eligible observation matches the diagnostic key.'); console.log(`price RSI(3): ${d.priceRsi}\ncurrent streak: ${d.streak}\nstreak RSI(2): ${d.streakRsi}\none-bar return: ${d.oneBarReturn}\n100-return percent rank: ${d.percentRank100}\nfinal CRSI: ${d.crsi}`); return; }
  const featureColumns = ['observation_id', ...JEV_FIELDS]; const outcomeColumns = ['observation_id', 'timestamp', ...OUTCOME_FIELDS];
  await writeFile('historical-features.csv', csv(built.features, featureColumns)); await writeFile('historical-outcomes.csv', csv(built.outcomes, outcomeColumns));
  const range = parsed.bars.length ? `${new Date(parsed.bars[0].barOpen).toISOString()} through ${new Date(parsed.bars.at(-1).barClose).toISOString()}` : 'n/a';
  const report = [`Historical predictive-validation report`, `Input bar count: ${parsed.bars.length}`, `Eligible observation count: ${built.features.length}`, `Normalized date/time range: ${range}`, `Input timezone: ${a['input-timezone'] || 'offsets embedded in input'}`, `Exchange timezone: ${options.exchangeTimezone}`, `Timestamp semantics: ${a['timestamp-semantics']}`, `Session mode: ${options.sessionMode}`, `Invalid/missing rows: ${parsed.invalidRows.length}`, ...parsed.invalidRows.map(x => `  row ${x.row}: ${x.reason}`), `Exclusions/warm-ups (categories overlap except insufficient future bars is counted after all feature warm-ups pass):`, ...Object.entries(built.exclusion).map(([k, v]) => `  ${k}: ${v}`), `First five feature rows:`, csv(built.features.slice(0, 5), featureColumns).trim(), `First five outcome rows:`, csv(built.outcomes.slice(0, 5), outcomeColumns).trim(), `Jev-safe confirmation: outcome fields are absent from every Jev-safe object; observation_id is CSV join metadata and is not in the allowlist.`].join('\n');
  await writeFile('historical-validation-report.txt', report + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });

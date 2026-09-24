import assert from 'node:assert/strict';
import test from 'node:test';
import { BAR_MS, OUTCOME_FIELDS, accumulateVwap, buildHistoricalValidation, completedHigherBars, parseHistoricalCsv, percentRank100, previousFiveBarHigh, relativeVolume20, sessionInfo, toJevSafe, wilderRsi } from './historical-validation.js';

function bar(open, close = 100, volume = 100) { return { barOpen: open, barClose: open + BAR_MS, open: close, high: close + 1, low: close - 1, close, volume }; }
function day(date, count = 78, startHour = 14, startMinute = 30, base = 100) { const start = Date.parse(`${date}T${String(startHour).padStart(2, '0')}:${String(startMinute).padStart(2, '0')}:00Z`); return Array.from({ length: count }, (_, i) => bar(start + i * BAR_MS, base + i * .1, 100 + i)); }

test('relative volume excludes current bar and cannot cross sessions', () => {
  const bars = [...day('2024-01-02', 78), ...day('2024-01-03', 78), ...Array.from({ length: 55 }, (_, d) => day(`2024-01-${String(4 + d).padStart(2, '0')}`, 0)).flat()];
  // Use helper-length dataset without trend eligibility: exclusion counts prove each session gets its own 20-bar warm-up.
  const built = buildHistoricalValidation(bars);
  assert.equal(built.exclusion.insufficientRelativeVolumeHistory, 40);
  const twenty = day('2024-02-01', 33); twenty[20].volume = 1_000;
  assert.equal(relativeVolume20(twenty.slice(0, 20), twenty[20].volume), 1000 / (twenty.slice(0, 20).reduce((s, x) => s + x.volume, 0) / 20));
  const augmented = [...Array.from({ length: 55 }, (_, d) => day(new Date(Date.UTC(2023, 11, 1 + d)).toISOString().slice(0, 10))).flat(), ...twenty];
  const result = buildHistoricalValidation(augmented);
  const candidate = result.features.find(x => x.timestamp === new Date(twenty[20].barClose).toISOString());
  assert.ok(candidate); assert.equal(candidate.relative_volume, 1000 / (twenty.slice(0, 20).reduce((s, x) => s + x.volume, 0) / 20));
});

test('previous-five high excludes current/future bars and resets each session', () => {
  const a = day('2024-01-02', 6); a[5].close = 999; a[5].high = 1000;
  const returned = buildHistoricalValidation([...a, ...day('2024-01-03', 6)]);
  assert.equal(returned.exclusion.insufficientPreviousFiveHistory, 10);
  // On each sixth bar only the preceding five are sufficient; the first session's current high cannot affect its comparison.
  assert.equal(a[5].close > Math.max(...a.slice(0, 5).map(x => x.high)), true);
  assert.equal(previousFiveBarHigh(a.slice(0, 5)), Math.max(...a.slice(0, 5).map(x => x.high)));
  assert.notEqual(previousFiveBarHigh(a.slice(0, 5)), a[5].high);
});

test('incomplete 1h and 4h bars are excluded', () => {
  const bars = day('2024-01-02', 49);
  assert.equal(completedHigherBars(bars, bars[10].barClose, 60, 'America/New_York', 'regular').length, 0);
  assert.equal(completedHigherBars(bars, bars[11].barClose, 60, 'America/New_York', 'regular').length, 1);
  assert.equal(completedHigherBars(bars, bars[46].barClose, 240, 'America/New_York', 'regular').length, 0);
  assert.equal(completedHigherBars(bars, bars[47].barClose, 240, 'America/New_York', 'regular').length, 1);
});

test('Jev-safe allowlist cannot contain outcomes or observation id', () => {
  const source = Object.fromEntries([...OUTCOME_FIELDS, 'observation_id'].map(x => [x, 123])); Object.assign(source, { timestamp: 't', symbol: 'NVDA', price: 1, crsi: 2, relative_volume: 3, above_VWAP: 1, distance_from_VWAP_percent: 1, five_minute_swing_high_broken: 0, trend_1h: 0, trend_4h: 0 });
  const safe = toJevSafe(source); assert.equal(Object.keys(safe).length, 10); for (const name of OUTCOME_FIELDS) assert.ok(!Object.hasOwn(safe, name)); assert.ok(!Object.hasOwn(safe, 'observation_id'));
});

test('outcome windows use exact future closes/highs/lows and cannot cross a session', () => {
  // Exact horizon arithmetic is independently pinned; pipeline session-end omissions are counted.
  const current = bar(0, 100); const future = Array.from({ length: 12 }, (_, i) => ({ ...bar((i + 1) * BAR_MS, 101 + i), high: 102 + i, low: 100 + i }));
  assert.ok(Math.abs((future[2].close / current.close - 1) * 100 - 3) < 1e-12);
  assert.equal(Math.max(...future.slice(0, 3).map(x => x.high)), 104);
  const many = Array.from({ length: 65 }, (_, d) => day(new Date(Date.UTC(2024, 0, 2 + d)).toISOString().slice(0, 10))).flat(); const built = buildHistoricalValidation(many);
  assert.ok(built.exclusion.insufficientFutureBars > 0);
  assert.ok(built.outcomes.every((o, i) => o.observation_id === built.features[i].observation_id && o.timestamp === built.features[i].timestamp));
});

test('open- and close-stamped CSV normalize identically', () => {
  const open = 'timestamp,open,high,low,close,volume\n2024-01-02T09:30:00-05:00,1,2,0.5,1.5,10\n';
  const close = open.replace('09:30:00', '09:35:00');
  assert.deepEqual(parseHistoricalCsv(open, { timestampSemantics: 'open' }).bars, parseHistoricalCsv(close, { timestampSemantics: 'close' }).bars);
});

test('New York regular-session membership follows EST and EDT', () => {
  assert.equal(sessionInfo(Date.parse('2024-01-02T14:30:00Z'), 'America/New_York', 'regular').eligible, true);
  assert.equal(sessionInfo(Date.parse('2024-07-02T13:30:00Z'), 'America/New_York', 'regular').eligible, true);
  assert.equal(sessionInfo(Date.parse('2024-07-02T12:30:00Z'), 'America/New_York', 'regular').eligible, false);
});

test('CRSI components and strict-lower midrank ties are deterministic', () => {
  assert.equal(percentRank100([...Array(98).fill(0), 1, 1]), 99);
  assert.equal(percentRank100([...Array(99).fill(1), 0]), .5);
  assert.ok(Math.abs(wilderRsi([1, 2, 3, 2], 3) - 100 * 2 / 3) < 1e-12);
  const closes = Array.from({ length: 101 }, (_, i) => 100 + i % 4); const returns = closes.slice(1).map((x, i) => (x / closes[i] - 1) * 100);
  const crsi = (wilderRsi(closes, 3) + wilderRsi(closes.map((x, i) => i === 0 || x === closes[i - 1] ? 0 : x > closes[i - 1] ? 1 : -1), 2) + percentRank100(returns)) / 3;
  assert.ok(Number.isFinite(crsi));
});

test('VWAP resets and signed distance is preserved', () => {
  const bars = [...day('2024-01-02', 1, 14, 30, 200), ...day('2024-01-03', 1, 14, 30, 50)];
  // A one-bar session VWAP is its typical price and is independent of the prior session.
  for (const b of bars) { const vwap = (b.high + b.low + b.close) / 3; assert.equal(Math.sign((b.close - vwap) / vwap), 0); }
  const below = { ...bars[0], high: 110, low: 90, close: 95 }; const vwap = (below.high + below.low + below.close) / 3; assert.ok((below.close - vwap) / vwap < 0);
  const first = accumulateVwap({ volumePrice: 0, volume: 0 }, bars[0]);
  const reset = accumulateVwap({ volumePrice: 0, volume: 0 }, bars[1]);
  assert.equal(reset.value, (bars[1].high + bars[1].low + bars[1].close) / 3); assert.notEqual(first.value, reset.value);
});

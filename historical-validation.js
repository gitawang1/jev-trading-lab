import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULTS = Object.freeze({
  inputTimezone: 'UTC',
  exchangeTimezone: 'America/New_York',
  session: 'regular',
  barTimestamp: 'open',
  barMinutes: 5,
});
const SESSIONS = Object.freeze({ regular: ['09:30', '16:00'], extended: ['04:00', '20:00'] });
const RVOL_WINDOW = 20;

function validTimezone(timeZone) {
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); return true; } catch { return false; }
}

function partsAt(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  return Object.fromEntries(parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, Number(value)]));
}

// Convert an unzoned local civil timestamp by asking Intl for the IANA zone offset at that instant.
export function localTimestampToInstant(value, timeZone) {
  if (!validTimezone(timeZone)) throw new Error(`Invalid input timezone: ${timeZone}`);
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!match) throw new Error(`Timestamp lacks an offset and is not ISO local time: ${value}`);
  const [, y, mo, d, h, mi, s = '0', fraction = '0'] = match;
  const wanted = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +fraction.padEnd(3, '0'));
  let guess = wanted;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const p = partsAt(new Date(guess), timeZone);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, +fraction.padEnd(3, '0'));
    const adjustment = wanted - represented;
    guess += adjustment;
    if (adjustment === 0) break;
  }
  const result = new Date(guess);
  const p = partsAt(result, timeZone);
  if ([p.year, p.month, p.day, p.hour, p.minute, p.second].join() !== [+y, +mo, +d, +h, +mi, +s].join()) {
    throw new Error(`Local timestamp is nonexistent or ambiguous in ${timeZone}: ${value}`);
  }
  return result;
}

export function normalizeTimestamp(value, inputTimezone = DEFAULTS.inputTimezone) {
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const instant = new Date(value);
    if (Number.isNaN(instant.valueOf())) throw new Error(`Invalid timestamp: ${value}`);
    return instant;
  }
  return localTimestampToInstant(value, inputTimezone);
}

function minuteOfDay(hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number);
  return hour * 60 + minute;
}

export function classifySession(timestamp, options = {}) {
  const config = { ...DEFAULTS, ...options };
  if (!validTimezone(config.exchangeTimezone)) throw new Error(`Invalid exchange timezone: ${config.exchangeTimezone}`);
  if (!SESSIONS[config.session]) throw new Error(`Unknown session: ${config.session}`);
  const instant = timestamp instanceof Date ? timestamp : normalizeTimestamp(timestamp, config.inputTimezone);
  const p = partsAt(instant, config.exchangeTimezone);
  const localMinute = p.hour * 60 + p.minute;
  const [start, end] = SESSIONS[config.session].map(minuteOfDay);
  // Session bounds describe instants: start inclusive, end exclusive. Close-stamped bars
  // belong by their opening instant, so shift by one configured bar duration.
  const membershipMinute = localMinute - (config.barTimestamp === 'close' ? config.barMinutes : 0);
  return {
    inSession: membershipMinute >= start && membershipMinute < end,
    normalizedInstant: instant.toISOString(),
    exchangeDate: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`,
    exchangeTime: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`,
  };
}

export function addRollingRelativeVolume(bars, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const historyBySession = new Map();
  return bars.map(bar => {
    const classified = classifySession(bar.timestamp, config);
    if (!classified.inSession) return { ...bar, ...classified, relativeVolume20BarProxy: null, eligible: false };
    const history = historyBySession.get(classified.exchangeDate) ?? [];
    const baseline = history.length >= RVOL_WINDOW
      ? history.slice(-RVOL_WINDOW).reduce((sum, volume) => sum + volume, 0) / RVOL_WINDOW : null;
    const result = { ...bar, ...classified, relativeVolume20BarProxy: baseline === null ? null : bar.volume / baseline, eligible: baseline !== null };
    history.push(bar.volume);
    historyBySession.set(classified.exchangeDate, history);
    return result;
  });
}

function parseArgs(argv) {
  const config = { ...DEFAULTS };
  let input;
  const names = { '--input-timezone': 'inputTimezone', '--exchange-timezone': 'exchangeTimezone', '--session': 'session', '--bar-timestamp': 'barTimestamp', '--bar-minutes': 'barMinutes', '--input': 'input' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = names[argv[i]];
    if (!key || i + 1 >= argv.length) throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    const value = argv[++i];
    if (key === 'input') input = value; else config[key] = key === 'barMinutes' ? Number(value) : value;
  }
  if (!validTimezone(config.inputTimezone) || !validTimezone(config.exchangeTimezone)) throw new Error('Timezone must be a valid IANA timezone.');
  if (!SESSIONS[config.session] || !['open', 'close'].includes(config.barTimestamp) || !(config.barMinutes > 0)) throw new Error('Invalid session or bar semantics.');
  return { config, input };
}

function assert(condition, message) { if (!condition) throw new Error(message); }

export function validateLocally() {
  const winter = classifySession('2024-01-15T14:30:00Z'); // EST (UTC-5)
  const summer = classifySession('2024-07-15T13:30:00Z'); // EDT (UTC-4)
  const beforeSpring = classifySession('2024-03-08T14:30:00Z');
  const afterSpring = classifySession('2024-03-11T13:30:00Z');
  const beforeFall = classifySession('2024-11-01T13:30:00Z');
  const afterFall = classifySession('2024-11-04T14:30:00Z');
  for (const row of [winter, summer, beforeSpring, afterSpring, beforeFall, afterFall]) {
    assert(row.inSession && row.exchangeTime === '09:30', 'DST-aware 09:30 membership failed.');
  }
  assert(!classifySession('2024-07-15T13:29:00Z').inSession, 'Pre-open instant entered regular session.');
  assert(classifySession('2024-07-15T08:00:00Z', { session: 'extended' }).inSession, 'Extended open failed.');
  assert(classifySession('2024-07-15 09:30', { inputTimezone: 'America/New_York' }).normalizedInstant === '2024-07-15T13:30:00.000Z', 'Input timezone normalization failed.');
  const bars = Array.from({ length: 21 }, (_, index) => ({ timestamp: `2024-07-15T${String(13 + Math.floor((30 + index * 5) / 60)).padStart(2, '0')}:${String((30 + index * 5) % 60).padStart(2, '0')}:00Z`, volume: 100 }));
  const withRvol = addRollingRelativeVolume(bars);
  assert(withRvol.slice(0, 20).every(bar => !bar.eligible) && withRvol[20].relativeVolume20BarProxy === 1, 'Rolling 20-bar proxy changed.');
  console.log('Historical validation passed: IANA/DST session checks and rolling 20-bar RVOL proxy; no request sent.');
}

async function main() {
  if (process.argv.includes('--validate')) return validateLocally();
  const { config, input } = parseArgs(process.argv.slice(2));
  if (!input) throw new Error('Provide --input <JSON file>.');
  const bars = JSON.parse(await readFile(input, 'utf8'));
  const observations = addRollingRelativeVolume(bars, config);
  console.log(JSON.stringify({ config, assumptions: { holidaysAndEarlyCloses: 'not modeled', relativeVolume: 'same-session rolling 20-bar proxy', regularSessionWarmupMinutes: config.session === 'regular' ? config.barMinutes * RVOL_WINDOW : null }, observations }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });

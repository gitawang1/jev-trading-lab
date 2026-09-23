import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_URL = 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
const RESULT_PATH = '/tmp/typesafe-jev-sensitivity-result.txt';
const CURL_TIMEOUT_SECONDS = 30;

const BASE_STATE = {
  symbol: 'PENGU',
  price: 0.0350,
  CRSI_3_2_100: 42,
  above_VWAP: true,
  above_POC: true,
  relative_volume: 1.6,
  five_minute_swing_high_broken: true,
  one_hour_trend: 'bullish',
  four_hour_trend: 'neutral',
  distance_from_VWAP_percent: 0.7,
};

const QUESTIONS = {
  trendConfirmed: {
    type: 'noul',
    instructions: 'Does the supplied market state support a sufficiently confirmed bullish short-term trend for consideration of a long trade?',
  },
  volumeConfirmed: {
    type: 'noul',
    instructions: 'Does the supplied market state show sufficient volume confirmation for the potential bullish move?',
  },
  momentumQuality: {
    type: 'noul',
    instructions: 'Does the supplied market state show constructive short-term momentum without being excessively overextended?',
  },
  acceptableChaseRisk: {
    type: 'noul',
    instructions: 'Is the current price sufficiently close to VWAP that entering here would avoid excessive chase/extension risk?',
  },
  setupQuality: {
    type: 'noul',
    instructions: 'Considering only the supplied market state, does this represent a high-quality short-term bullish trading setup?',
  },
};

const QUESTION_NAMES = Object.keys(QUESTIONS);

const SCENARIOS = [
  { id: 'baseline', label: 'Baseline', patch: {}, hypothesis: null },
  { id: 'overextended_crsi', label: 'Overextended CRSI', patch: { CRSI_3_2_100: 78 }, hypothesis: { question: 'momentumQuality', direction: 'down' } },
  { id: 'weak_volume', label: 'Weak volume', patch: { relative_volume: 0.7 }, hypothesis: { question: 'volumeConfirmed', direction: 'down' } },
  { id: 'below_vwap', label: 'Below VWAP', patch: { above_VWAP: false }, hypothesis: { question: 'trendConfirmed', direction: 'down' } },
  { id: 'no_breakout', label: 'No 5-minute swing-high breakout', patch: { five_minute_swing_high_broken: false }, hypothesis: { question: 'trendConfirmed', direction: 'down' } },
  { id: 'bearish_1h', label: 'Bearish 1-hour trend', patch: { one_hour_trend: 'bearish' }, hypothesis: { question: 'trendConfirmed', direction: 'down' } },
  { id: 'bullish_4h', label: 'Bullish 4-hour trend', patch: { four_hour_trend: 'bullish' }, hypothesis: { question: 'trendConfirmed', direction: 'up' } },
  { id: 'chasing', label: 'Price extended from VWAP', patch: { distance_from_VWAP_percent: 4.0 }, hypothesis: { question: 'acceptableChaseRisk', direction: 'down' } },
  { id: 'stronger_volume', label: 'Stronger volume', patch: { relative_volume: 2.5 }, hypothesis: { question: 'volumeConfirmed', direction: 'up' } },
  { id: 'crsi_pullback', label: 'CRSI pullback', patch: { CRSI_3_2_100: 25 }, hypothesis: null },
];

function requestFor(scenario) {
  return {
    state: { ...BASE_STATE, ...scenario.patch },
    questions: QUESTIONS,
    model: 'jev-latest',
  };
}

function validateDefinitions() {
  if (SCENARIOS.length !== 10) throw new Error('Sensitivity test must contain exactly 10 scenarios.');
  if (SCENARIOS[0].id !== 'baseline' || Object.keys(SCENARIOS[0].patch).length !== 0) {
    throw new Error('First scenario must be the unchanged baseline.');
  }
  const expectedKeys = Object.keys(BASE_STATE).sort();
  for (const scenario of SCENARIOS) {
    const state = requestFor(scenario).state;
    if (JSON.stringify(Object.keys(state).sort()) !== JSON.stringify(expectedKeys)) throw new Error(`Invalid state shape: ${scenario.id}`);
    JSON.parse(JSON.stringify(requestFor(scenario)));
  }
}

function requireApiKey() {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) throw new Error('AI_GATEWAY_API_KEY is unavailable.');
  return apiKey;
}

function readNoul(payload, name) {
  const value = payload?.answers?.[name]?.noul;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid ${name} Noul answer.`);
  }
  return value;
}

const SAFE_ERROR_KEYS = ['type', 'code', 'message'];
const CREDENTIAL_VALUE = /(?:authorization|proxy-authorization|api[-_ ]?key|credential)\s*[:=]\s*\S+|(?:bearer|basic)\s+\S+/i;

function safeErrorFields(rawBody) {
  if (!rawBody || rawBody.length > 64_000) return [];
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch { return []; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const fields = [];
  for (const [prefix, source] of [['error', parsed.error], [null, parsed]]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const key of SAFE_ERROR_KEYS) {
      if (!Object.hasOwn(source, key)) continue;
      const value = source[key];
      const safe = value === null || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && !CREDENTIAL_VALUE.test(value));
      if (safe) fields.push([prefix ? `${prefix}.${key}` : key, value]);
    }
  }
  return fields;
}

function sanitizedFailure(status, rawBody = '') {
  const fields = safeErrorFields(rawBody);
  return {
    status: status ?? 'unavailable',
    detail: fields.length
      ? fields.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('; ')
      : 'Vercel returned no safely displayable error detail.',
  };
}

function runCurl(apiKey, requestPath, responsePath) {
  const args = [
    '--silent', '--show-error', '--max-time', String(CURL_TIMEOUT_SECONDS),
    '--request', 'POST', '--header', 'Content-Type: application/json',
    '--data-binary', `@${requestPath}`, '--output', responsePath,
    '--write-out', '%{http_code}', '--config', '-', API_URL,
  ];
  const { AI_GATEWAY_API_KEY: _secret, ...curlEnvironment } = process.env;
  return new Promise(resolve => {
    const startedAt = process.hrtime.bigint();
    const child = spawn('curl', args, { env: curlEnvironment, stdio: ['pipe', 'pipe', 'pipe'] });
    let statusOutput = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { statusOutput += chunk; });
    child.stderr.resume();
    child.on('error', () => resolve({ code: null, statusOutput: '', latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6 }));
    child.on('close', code => resolve({ code, statusOutput, latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6 }));
    child.stdin.on('error', () => {});
    child.stdin.end(`header = "Authorization: Bearer ${apiKey}"\n`);
  });
}

async function executeScenario(apiKey, scenario, index) {
  const directory = await mkdtemp(join(tmpdir(), `typesafe-jev-sensitivity-${index}-`));
  const requestPath = join(directory, 'request.json');
  const responsePath = join(directory, 'response.json');
  try {
    await writeFile(requestPath, JSON.stringify(requestFor(scenario)), { mode: 0o600 });
    const result = await runCurl(apiKey, requestPath, responsePath);
    const status = /^\d{3}$/.test(result.statusOutput) && result.statusOutput !== '000' ? Number(result.statusOutput) : null;
    let rawBody = '';
    try { rawBody = await readFile(responsePath, 'utf8'); } catch {}
    if (result.code !== 0 || status === null || status < 200 || status >= 300) {
      return { scenario, success: false, latencyMs: result.latencyMs, failure: sanitizedFailure(status, rawBody) };
    }
    try {
      const payload = JSON.parse(rawBody);
      const nouls = Object.fromEntries(QUESTION_NAMES.map(name => [name, readNoul(payload, name)]));
      return { scenario, success: true, status, latencyMs: result.latencyMs, nouls };
    } catch {
      return { scenario, success: false, latencyMs: result.latencyMs, failure: sanitizedFailure(status) };
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function directionalResult(delta, direction) {
  if (delta === 0) return 'unchanged';
  const satisfied = direction === 'up' ? delta > 0 : delta < 0;
  return satisfied ? 'satisfied' : 'not_satisfied';
}

function formatReport(results) {
  const lines = [
    'TypeSafe Jev synthetic sensitivity test',
    `Expected scenarios: ${SCENARIOS.length}`,
    `Completed scenarios: ${results.length}`,
    '',
    'scenario | status | latency_ms | trendConfirmed | volumeConfirmed | momentumQuality | acceptableChaseRisk | setupQuality',
  ];
  for (const result of results) {
    if (result.success) {
      lines.push([result.scenario.id, result.status, result.latencyMs.toFixed(1), ...QUESTION_NAMES.map(name => result.nouls[name].toFixed(4))].join(' | '));
    } else {
      lines.push([result.scenario.id, result.failure.status, result.latencyMs?.toFixed(1) ?? 'n/a', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL'].join(' | '));
      lines.push(`failure.${result.scenario.id}: ${result.failure.detail}`);
    }
  }

  const baseline = results.find(result => result.scenario.id === 'baseline' && result.success);
  lines.push('', 'Deltas versus baseline');
  if (!baseline) {
    lines.push('Baseline unavailable; deltas and hypothesis checks unavailable.');
    return `${lines.join('\n')}\n`;
  }
  lines.push('scenario | trendConfirmed | volumeConfirmed | momentumQuality | acceptableChaseRisk | setupQuality | hypothesis');
  for (const result of results) {
    if (!result.success) continue;
    const deltas = Object.fromEntries(QUESTION_NAMES.map(name => [name, result.nouls[name] - baseline.nouls[name]]));
    let hypothesis = 'exploratory';
    if (result.scenario.id === 'baseline') hypothesis = 'baseline';
    else if (result.scenario.hypothesis) {
      const { question, direction } = result.scenario.hypothesis;
      hypothesis = `${question} expected_${direction}: ${directionalResult(deltas[question], direction)}`;
    }
    lines.push([
      result.scenario.id,
      ...QUESTION_NAMES.map(name => (deltas[name] >= 0 ? '+' : '') + deltas[name].toFixed(4)),
      hypothesis,
    ].join(' | '));
  }
  return `${lines.join('\n')}\n`;
}

async function saveResult(contents) {
  const temporaryPath = `${RESULT_PATH}.${process.pid}`;
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  await rename(temporaryPath, RESULT_PATH);
}

function validateLocally() {
  validateDefinitions();
  const baselineNouls = {
    trendConfirmed: 0.73, volumeConfirmed: 0.72, momentumQuality: 0.82,
    acceptableChaseRisk: 0.85, setupQuality: 0.68,
  };
  const mockResults = SCENARIOS.map((scenario, index) => ({
    scenario, success: true, status: 200, latencyMs: 400 + index,
    nouls: { ...baselineNouls },
  }));
  mockResults.find(r => r.scenario.id === 'overextended_crsi').nouls.momentumQuality = 0.60;
  mockResults.find(r => r.scenario.id === 'weak_volume').nouls.volumeConfirmed = 0.50;
  mockResults.find(r => r.scenario.id === 'below_vwap').nouls.trendConfirmed = 0.60;
  mockResults.find(r => r.scenario.id === 'no_breakout').nouls.trendConfirmed = 0.61;
  mockResults.find(r => r.scenario.id === 'bearish_1h').nouls.trendConfirmed = 0.40;
  mockResults.find(r => r.scenario.id === 'bullish_4h').nouls.trendConfirmed = 0.80;
  mockResults.find(r => r.scenario.id === 'chasing').nouls.acceptableChaseRisk = 0.30;
  mockResults.find(r => r.scenario.id === 'stronger_volume').nouls.volumeConfirmed = 0.80;
  const report = formatReport(mockResults);
  const required = ['Expected scenarios: 10', 'overextended_crsi', 'weak_volume', 'chasing', 'expected_down: satisfied', 'expected_up: satisfied'];
  for (const marker of required) if (!report.includes(marker)) throw new Error(`Missing validation marker: ${marker}`);

  const invalid = { answers: { trendConfirmed: { noul: 1.1 } } };
  let rejected = false;
  try { readNoul(invalid, 'trendConfirmed'); } catch { rejected = true; }
  if (!rejected) throw new Error('Invalid Noul was not rejected.');

  console.log('Validated 10 synthetic scenarios, baseline deltas, directional hypotheses, and safe formatting; no credential read and no network request sent.');
}

async function main() {
  if (process.argv.includes('--validate')) {
    validateLocally();
    return;
  }
  await rm(RESULT_PATH, { force: true });
  validateDefinitions();
  const apiKey = requireApiKey();
  const results = [];
  for (let index = 0; index < SCENARIOS.length; index += 1) {
    results.push(await executeScenario(apiKey, SCENARIOS[index], index + 1));
  }
  await saveResult(formatReport(results));
  if (results.some(result => !result.success)) process.exitCode = 1;
}

main().catch(async () => {
  try { await saveResult('TypeSafe Jev synthetic sensitivity test\nTest failed before a safe result could be produced.\n'); } catch {}
  process.exitCode = 1;
});

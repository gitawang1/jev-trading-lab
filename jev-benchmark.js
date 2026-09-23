import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_URL = 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
const RESULT_PATH = '/tmp/typesafe-jev-benchmark-result.txt';
const CURL_TIMEOUT_SECONDS = 30;
const RUN_COUNT = 10;

const request = {
  state: {
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
  },
  questions: {
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
  },
  model: 'jev-latest',
};

const QUESTION_NAMES = [
  'trendConfirmed',
  'volumeConfirmed',
  'momentumQuality',
  'acceptableChaseRisk',
  'setupQuality',
];

function validateRequest(payload) {
  if (JSON.stringify(payload) !== JSON.stringify(request)) {
    throw new Error('The request does not match the fictional PENGU systemOne schema.');
  }
  JSON.parse(JSON.stringify(payload));
}

function requireApiKey() {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) throw new Error('AI_GATEWAY_API_KEY is unavailable.');
  return apiKey;
}

function readNoul(payload, name) {
  const value = payload?.answers?.[name]?.noul;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`The gateway returned an invalid ${name} Noul answer.`);
  }
  return value;
}

const SAFE_ERROR_KEYS = ['type', 'code', 'message'];
const CREDENTIAL_VALUE =
  /(?:authorization|proxy-authorization|api[-_ ]?key|credential)\s*[:=]\s*\S+|(?:bearer|basic)\s+\S+/i;

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
      const safe =
        value === null ||
        typeof value === 'boolean' ||
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
    '--request', 'POST',
    '--header', 'Content-Type: application/json',
    '--data-binary', `@${requestPath}`,
    '--output', responsePath,
    '--write-out', '%{http_code}',
    '--config', '-',
    API_URL,
  ];
  const { AI_GATEWAY_API_KEY: _secret, ...curlEnvironment } = process.env;
  return new Promise(resolve => {
    const startedAt = process.hrtime.bigint();
    const child = spawn('curl', args, { env: curlEnvironment, stdio: ['pipe', 'pipe', 'pipe'] });
    let statusOutput = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { statusOutput += chunk; });
    child.stderr.resume();
    child.on('error', () => {
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      resolve({ code: null, statusOutput: '', latencyMs });
    });
    child.on('close', code => {
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      resolve({ code, statusOutput, latencyMs });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`header = "Authorization: Bearer ${apiKey}"\n`);
  });
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function nearestRankP95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

function populationSd(values) {
  const average = mean(values);
  return Math.sqrt(mean(values.map(value => (value - average) ** 2)));
}

function stats(values, includeP95 = false) {
  if (!values.length) return null;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return {
    min: minimum,
    max: maximum,
    mean: mean(values),
    median: median(values),
    ...(includeP95 ? { p95: nearestRankP95(values) } : { sd: populationSd(values), range: maximum - minimum }),
  };
}

function formatNumber(value, digits = 4) {
  return Number(value).toFixed(digits);
}

function formatReport(runs) {
  const lines = [
    'TypeSafe Jev repeatability benchmark',
    `Expected runs: ${RUN_COUNT}`,
    `Completed runs: ${runs.length}`,
    '',
    'run | status | latency_ms | trendConfirmed | volumeConfirmed | momentumQuality | acceptableChaseRisk | setupQuality | failure',
  ];
  for (const run of runs) {
    if (run.success) {
      lines.push([
        run.run, run.status, run.latencyMs.toFixed(1),
        ...QUESTION_NAMES.map(name => formatNumber(run.nouls[name])),
        '',
      ].join(' | '));
    } else {
      lines.push([run.run, run.failure.status, run.latencyMs?.toFixed(1) ?? 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', run.failure.detail].join(' | '));
    }
  }

  const successful = runs.filter(run => run.success);
  lines.push('', `Successful runs: ${successful.length}`, `Failed runs: ${runs.length - successful.length}`);
  if (!successful.length) {
    lines.push('No successful runs; summary statistics unavailable.');
    return `${lines.join('\n')}\n`;
  }

  const latency = stats(successful.map(run => run.latencyMs), true);
  lines.push(
    '',
    'Latency summary (ms; successful runs only)',
    `min: ${formatNumber(latency.min, 1)}`,
    `max: ${formatNumber(latency.max, 1)}`,
    `mean: ${formatNumber(latency.mean, 1)}`,
    `median: ${formatNumber(latency.median, 1)}`,
    `p95_nearest_rank: ${formatNumber(latency.p95, 1)}`,
    '',
    'Noul summaries (successful runs only; SD is population SD)',
    'name | min | max | mean | median | population_sd | range',
  );
  for (const name of QUESTION_NAMES) {
    const summary = stats(successful.map(run => run.nouls[name]));
    lines.push([
      name,
      formatNumber(summary.min),
      formatNumber(summary.max),
      formatNumber(summary.mean),
      formatNumber(summary.median),
      formatNumber(summary.sd),
      formatNumber(summary.range),
    ].join(' | '));
  }
  return `${lines.join('\n')}\n`;
}

async function saveResult(contents) {
  const temporaryPath = `${RESULT_PATH}.${process.pid}`;
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  await rename(temporaryPath, RESULT_PATH);
}

async function executeOne(apiKey, runNumber) {
  const directory = await mkdtemp(join(tmpdir(), `typesafe-jev-benchmark-${runNumber}-`));
  const requestPath = join(directory, 'request.json');
  const responsePath = join(directory, 'response.json');
  try {
    await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
    const result = await runCurl(apiKey, requestPath, responsePath);
    const status = /^\d{3}$/.test(result.statusOutput) && result.statusOutput !== '000'
      ? Number(result.statusOutput) : null;
    let rawBody = '';
    try { rawBody = await readFile(responsePath, 'utf8'); } catch {}
    if (result.code !== 0 || status === null || status < 200 || status >= 300) {
      return { run: runNumber, success: false, latencyMs: result.latencyMs, failure: sanitizedFailure(status, rawBody) };
    }
    try {
      const payload = JSON.parse(rawBody);
      const nouls = Object.fromEntries(QUESTION_NAMES.map(name => [name, readNoul(payload, name)]));
      return { run: runNumber, success: true, status, latencyMs: result.latencyMs, nouls };
    } catch {
      return { run: runNumber, success: false, latencyMs: result.latencyMs, failure: sanitizedFailure(status) };
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertClose(actual, expected, label, tolerance = 1e-12) {
  if (Math.abs(actual - expected) > tolerance) throw new Error(`${label} validation failed.`);
}

function validateLocally() {
  validateRequest(request);
  if (RUN_COUNT !== 10) throw new Error('Benchmark must require exactly 10 runs.');
  const sample = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assertClose(mean(sample), 5.5, 'mean');
  assertClose(median(sample), 5.5, 'even median');
  assertClose(median([1, 2, 3, 4, 5]), 3, 'odd median');
  assertClose(nearestRankP95(sample), 10, 'P95');
  assertClose(populationSd([1, 2, 3]), Math.sqrt(2 / 3), 'population SD');
  const rangeStats = stats([0.2, 0.5, 0.8]);
  assertClose(rangeStats.range, 0.6, 'range');

  const validPayload = {
    answers: Object.fromEntries(QUESTION_NAMES.map((name, index) => [name, { noul: 0.5 + index * 0.05 }])),
  };
  for (const name of QUESTION_NAMES) readNoul(validPayload, name);
  for (const name of QUESTION_NAMES) {
    const missing = structuredClone(validPayload);
    delete missing.answers[name];
    let rejected = false;
    try { readNoul(missing, name); } catch { rejected = true; }
    if (!rejected) throw new Error(`Missing ${name} was not rejected.`);
  }
  for (const invalid of [-0.01, 1.01, NaN, Infinity, '0.5']) {
    const bad = structuredClone(validPayload);
    bad.answers.trendConfirmed.noul = invalid;
    let rejected = false;
    try { readNoul(bad, 'trendConfirmed'); } catch { rejected = true; }
    if (!rejected) throw new Error('Invalid Noul was not rejected.');
  }

  const mockRuns = Array.from({ length: RUN_COUNT }, (_, index) => ({
    run: index + 1,
    success: true,
    status: 200,
    latencyMs: 100 + index,
    nouls: Object.fromEntries(QUESTION_NAMES.map((name, questionIndex) => [name, 0.5 + questionIndex * 0.05])),
  }));
  const report = formatReport(mockRuns);
  if (!report.includes('Expected runs: 10') || !report.includes('p95_nearest_rank: 109.0')) {
    throw new Error('Mock report validation failed.');
  }
  console.log('Validated 10-run benchmark statistics, five Noul fields, and mock report; no credential read and no network request sent.');
}

async function main() {
  if (process.argv.includes('--validate')) {
    validateLocally();
    return;
  }

  await rm(RESULT_PATH, { force: true });
  validateRequest(request);
  const apiKey = requireApiKey();
  const runs = [];
  for (let runNumber = 1; runNumber <= RUN_COUNT; runNumber += 1) {
    runs.push(await executeOne(apiKey, runNumber));
  }
  await saveResult(formatReport(runs));
  if (runs.some(run => !run.success)) process.exitCode = 1;
}

main().catch(async () => {
  try {
    await saveResult('TypeSafe Jev repeatability benchmark\nBenchmark failed before a safe result could be produced.\n');
  } catch {}
  process.exitCode = 1;
});

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_URL = 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
const RESULT_PATH = '/tmp/typesafe-jev-test-result.txt';
const CURL_TIMEOUT_SECONDS = 30;

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
  const answer = payload?.answers?.[name];
  if (
    typeof answer?.noul !== 'number' ||
    !Number.isFinite(answer.noul) ||
    answer.noul < 0 ||
    answer.noul > 1
  ) {
    throw new Error(`The gateway returned an invalid ${name} Noul answer.`);
  }
  return answer.noul;
}

function formatSuccess(payload, status, latencyMs) {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) {
    throw new Error('The request latency is invalid.');
  }
  const lines = [
    `HTTP status: ${status}`,
    'Result: success',
    `Jev request latency ms: ${latencyMs.toFixed(1)}`,
  ];
  for (const name of QUESTION_NAMES) lines.push(`${name}.noul: ${readNoul(payload, name)}`);
  return `${lines.join('\n')}\n`;
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

function formatFailure(status, rawBody = '') {
  const lines = [`HTTP status: ${status ?? 'unavailable'}`];
  const fields = safeErrorFields(rawBody);
  if (fields.length === 0) lines.push('Vercel returned no safely displayable error detail.');
  else for (const [name, value] of fields) lines.push(`${name}: ${JSON.stringify(value)}`);
  return `${lines.join('\n')}\n`;
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

async function saveResult(contents) {
  const temporaryPath = `${RESULT_PATH}.${process.pid}`;
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  await rename(temporaryPath, RESULT_PATH);
}

function validateLocally() {
  validateRequest(request);
  const mockAnswers = Object.fromEntries(
    QUESTION_NAMES.map((name, index) => [name, { noul: 0.70 + index * 0.05 }]),
  );
  const success = formatSuccess({ answers: mockAnswers }, 200, 487.2);
  const failure = formatFailure(
    403,
    JSON.stringify({ error: { type: 'forbidden', code: 'denied', message: 'Access denied' } }),
  );
  for (const name of QUESTION_NAMES) {
    if (!success.includes(`${name}.noul:`)) throw new Error(`Missing ${name} output.`);
  }
  if (!success.includes('Jev request latency ms: 487.2') || !failure.includes('error.code: "denied"')) {
    throw new Error('Local response formatting validation failed.');
  }
  console.log(`Validated POST ${API_URL}, PENGU request, five Nouls, latency, and sanitized samples; no request sent.`);
}

async function main() {
  if (process.argv.includes('--validate')) {
    validateLocally();
    return;
  }

  // Prevent a prior successful diagnostic from being mistaken for this run.
  await rm(RESULT_PATH, { force: true });

  validateRequest(request);
  const apiKey = requireApiKey();
  const directory = await mkdtemp(join(tmpdir(), 'typesafe-jev-'));
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
      await saveResult(formatFailure(status, rawBody));
      process.exitCode = 1;
      return;
    }

    try {
      const payload = JSON.parse(rawBody);
      await saveResult(formatSuccess(payload, status, result.latencyMs));
    } catch {
      await saveResult(formatFailure(status));
      process.exitCode = 1;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(async () => {
  try { await saveResult(formatFailure(null)); } catch {}
  process.exitCode = 1;
});

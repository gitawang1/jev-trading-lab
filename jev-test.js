import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_URL = 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
const RESULT_PATH = '/tmp/typesafe-jev-test-result.txt';
const CURL_TIMEOUT_SECONDS = 30;

// This is the wire shape produced by TypeSafeClient.systemOne with one noul.
const request = {
  state: 'The support agent issued a full refund to the customer.',
  questions: {
    refunded: {
      type: 'noul',
      instructions: 'Was a refund issued?',
    },
  },
  model: 'jev-latest',
};

function validateRequest(payload) {
  if (JSON.stringify(payload) !== JSON.stringify(request)) {
    throw new Error('The request does not match the minimal systemOne schema.');
  }
  JSON.parse(JSON.stringify(payload));
}

function requireApiKey() {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error('AI_GATEWAY_API_KEY is unavailable.');
  }
  return apiKey;
}

function formatSuccess(payload, status) {
  const answer = payload?.answers?.refunded;
  if (
    answer?.type !== 'noul' ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul) ||
    answer.noul < 0 ||
    answer.noul > 1
  ) {
    throw new Error('The gateway returned an unexpected response shape.');
  }

  return `HTTP status: ${status}\nResult: success\nrefunded.noul: ${answer.noul}\n`;
}

const SAFE_ERROR_KEYS = ['type', 'code', 'message'];
const CREDENTIAL_VALUE =
  /(?:authorization|proxy-authorization|api[-_ ]?key|credential)\s*[:=]\s*\S+|(?:bearer|basic)\s+\S+/i;

function safeErrorFields(rawBody) {
  if (!rawBody || rawBody.length > 64_000) return [];

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const fields = [];
  for (const [prefix, source] of [
    ['error', parsed.error],
    [null, parsed],
  ]) {
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
  if (fields.length === 0) {
    lines.push('Vercel returned no safely displayable error detail.');
  } else {
    for (const [name, value] of fields) lines.push(`${name}: ${JSON.stringify(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

function runCurl(apiKey, requestPath, responsePath) {
  const args = [
    '--silent',
    '--show-error',
    '--max-time',
    String(CURL_TIMEOUT_SECONDS),
    '--request',
    'POST',
    '--header',
    'Content-Type: application/json',
    '--data-binary',
    `@${requestPath}`,
    '--output',
    responsePath,
    '--write-out',
    '%{http_code}',
    '--config',
    '-',
    API_URL,
  ];
  const { AI_GATEWAY_API_KEY: _secret, ...curlEnvironment } = process.env;

  return new Promise(resolve => {
    const child = spawn('curl', args, {
      env: curlEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let statusOutput = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      statusOutput += chunk;
    });
    child.stderr.resume();
    child.on('error', () => resolve({ code: null, statusOutput: '' }));
    child.on('close', code => resolve({ code, statusOutput }));
    child.stdin.on('error', () => {});

    // Curl reads the secret from stdin; it is absent from argv, files, and curl's env.
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
  const success = formatSuccess(
    { answers: { refunded: { type: 'noul', noul: 0.98 } } },
    200,
  );
  const failure = formatFailure(
    403,
    JSON.stringify({ error: { type: 'forbidden', code: 'denied', message: 'Access denied' } }),
  );
  if (!success.includes('refunded.noul: 0.98') || !failure.includes('error.code: "denied"')) {
    throw new Error('Local response formatting validation failed.');
  }
  console.log(`Validated POST ${API_URL} and sanitized sample responses; no request sent.`);
}

async function main() {
  if (process.argv.includes('--validate')) {
    validateLocally();
    return;
  }

  validateRequest(request);
  const apiKey = requireApiKey();
  const directory = await mkdtemp(join(tmpdir(), 'typesafe-jev-'));
  const requestPath = join(directory, 'request.json');
  const responsePath = join(directory, 'response.json');

  try {
    await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
    const result = await runCurl(apiKey, requestPath, responsePath);
    const status = /^\d{3}$/.test(result.statusOutput) && result.statusOutput !== '000'
      ? Number(result.statusOutput)
      : null;

    let rawBody = '';
    try {
      rawBody = await readFile(responsePath, 'utf8');
    } catch {
      // An absent response body has no safe details to retain.
    }

    if (result.code !== 0 || status === null || status < 200 || status >= 300) {
      await saveResult(formatFailure(status, rawBody));
      process.exitCode = 1;
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
      await saveResult(formatSuccess(payload, status));
    } catch {
      await saveResult(formatFailure(status));
      process.exitCode = 1;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(async () => {
  try {
    await saveResult(formatFailure(null));
  } catch {
    // Never replace the safe diagnostic with potentially sensitive exception text.
  }
  process.exitCode = 1;
});

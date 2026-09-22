import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_URL = 'https://ai-gateway.vercel.sh/v1/evaluate';
const CURL_TIMEOUT_SECONDS = 30;

// This is deliberately the smallest request shown by Vercel for a native Jev
// evaluation. Keep it small until the secure Setup-phase diagnostic succeeds.
const request = {
  model: 'typesafe-ai/jev',
  state: 'The support agent issued a full refund to the customer.',
  questions: {
    refunded: {
      type: 'boolean',
      instructions: 'Was a refund issued?',
    },
  },
};

function validateRequest(payload) {
  const expected = JSON.stringify(request);
  if (JSON.stringify(payload) !== expected) {
    throw new Error('The Jev request does not match the documented minimal schema.');
  }

  JSON.parse(expected);
}

function requireApiKey() {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error(
      'AI_GATEWAY_API_KEY is unavailable. Set it in the environment and retry.',
    );
  }
  return apiKey;
}

function formatAnswer(payload) {
  const probability = payload?.answers?.refunded?.probability;
  if (
    typeof probability !== 'number' ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  ) {
    throw new Error('The gateway returned an unexpected response shape.');
  }

  return { refunded: probability >= 0.5, probability };
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

  return new Promise(resolve => {
    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let statusOutput = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      statusOutput += chunk;
    });
    // Drain curl diagnostics without displaying potentially unsafe remote text.
    child.stderr.resume();
    child.on('error', () => resolve({ code: null, statusOutput: '' }));
    child.on('close', code => resolve({ code, statusOutput }));
    child.stdin.on('error', () => {});

    // Supplying the secret through curl's stdin keeps it out of argv/process lists.
    child.stdin.end(`header = "Authorization: Bearer ${apiKey}"\n`);
  });
}

function printHttpResult(received, status) {
  console.log(`HTTP response received: ${received ? 'yes' : 'no'}`);
  console.log(`HTTP status: ${status ?? 'unavailable'}`);
}

const SAFE_ERROR_KEYS = ['type', 'code', 'message'];
const CREDENTIAL_VALUE =
  /(?:authorization|proxy-authorization|api[-_ ]?key|credential)\s*[:=]\s*\S+|(?:bearer|basic)\s+\S+/i;

function sanitizeVercelError(rawBody) {
  if (!rawBody || rawBody.length > 64_000) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const fields = [];
  const sources = [
    ['error', parsed.error],
    [null, parsed],
  ];
  for (const [prefix, source] of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;

    for (const key of SAFE_ERROR_KEYS) {
      if (!Object.hasOwn(source, key)) continue;
      const value = source[key];
      const isSafeScalar =
        value === null ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && !CREDENTIAL_VALUE.test(value));
      if (isSafeScalar) {
        fields.push([prefix ? `${prefix}.${key}` : key, value]);
      }
    }
  }
  return fields.length > 0 ? fields : null;
}

async function reportHttpError(responsePath, status) {
  let safeError = null;
  try {
    safeError = sanitizeVercelError(await readFile(responsePath, 'utf8'));
  } catch {
    // A missing/unreadable response has nothing safe to report.
  }

  console.error(`API error: Vercel AI Gateway returned HTTP ${status}.`);
  if (safeError) {
    for (const [field, value] of safeError) {
      console.error(`${field}: ${JSON.stringify(value)}`);
    }
  } else {
    console.error('Vercel returned no safely displayable error detail.');
  }
}

async function main() {
  validateRequest(request);
  if (process.argv.includes('--validate-request')) {
    console.log(JSON.stringify(request, null, 2));
    console.log(`Valid minimal Jev request for POST ${API_URL}.`);
    return;
  }

  let apiKey;
  try {
    apiKey = requireApiKey();
  } catch (error) {
    printHttpResult(false);
    console.error(`API error: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), 'jev-gateway-'));
  const requestPath = join(directory, 'request.json');
  const responsePath = join(directory, 'response.json');

  try {
    await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
    const result = await runCurl(apiKey, requestPath, responsePath);
    const status = /^\d{3}$/.test(result.statusOutput)
      ? Number(result.statusOutput)
      : null;
    const received = status !== null && status !== 0;
    printHttpResult(received, received ? status : null);

    if (result.code !== 0 || !received) {
      throw new Error(`curl transport failed (exit ${result.code ?? 'unknown'}).`);
    }
    if (status < 200 || status >= 300) {
      await reportHttpError(responsePath, status);
      process.exitCode = 1;
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readFile(responsePath, 'utf8'));
    } catch {
      throw new Error('The gateway returned invalid JSON.');
    }
    console.log('Structured Jev evaluation:');
    console.log(JSON.stringify(formatAnswer(payload), null, 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  const safeMessage =
    error instanceof Error ? error.message : 'An unknown error occurred.';
  console.error(`API error: ${safeMessage}`);
  process.exitCode = 1;
});

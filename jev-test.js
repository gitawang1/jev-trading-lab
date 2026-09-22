import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_URL = 'https://ai-gateway.vercel.sh/v1/evaluate';
const MODEL = 'typesafe-ai/jev';
const CURL_TIMEOUT_SECONDS = 30;
const SCORE_MAX = 9;

const marketState = {
  dataClassification: 'FICTIONAL TEST DATA',
  symbol: 'PENGU',
  price: 0.0318,
  crsi_3_2_100: 71.4,
  vwap: 0.0309,
  poc: 0.0304,
  relativeVolume: 1.82,
  fiveMinuteSwingHigh: 0.0322,
  priceAboveVwap: true,
  oneHourTrend: 'UP',
  fourHourTrend: 'UP',
};

const questions = {
  action: {
    type: 'choice',
    instructions:
      'Select the single best non-executing observation status for this fictional setup.',
    criteria: {
      WATCH: 'Interesting, but conditions need more development.',
      READY: 'Conditions are strong and near a hypothetical trigger, but do not enter.',
      ENTER: 'All supplied fictional conditions support a hypothetical entry now.',
      AVOID: 'Conditions are conflicting or unsuitable.',
    },
  },
  trendConfirmed: {
    type: 'boolean',
    instructions:
      'Are the supplied 1-hour and 4-hour trends aligned bullishly and confirmed by price above VWAP?',
  },
  volumeConfirmed: {
    type: 'boolean',
    instructions:
      'Does the supplied relative volume confirm meaningful above-normal participation?',
  },
  setupQuality: {
    type: 'score',
    instructions:
      'Score the overall quality of this fictional setup from 0 (worst) through 9 (best).',
    criteria: Array.from({ length: SCORE_MAX + 1 }, (_, score) => `${score}/${SCORE_MAX}`),
  },
};

const request = { model: MODEL, state: marketState, questions };

function validateRequest(payload) {
  if (
    payload?.model !== MODEL ||
    payload?.state?.dataClassification !== 'FICTIONAL TEST DATA' ||
    payload?.state?.symbol !== 'PENGU' ||
    !payload?.questions ||
    Object.keys(payload.questions).length !== 4
  ) {
    throw new Error('The Jev request does not match the expected schema.');
  }

  const { action, trendConfirmed, volumeConfirmed, setupQuality } =
    payload.questions;
  if (
    action?.type !== 'choice' ||
    JSON.stringify(Object.keys(action.criteria ?? {})) !==
      JSON.stringify(['WATCH', 'READY', 'ENTER', 'AVOID']) ||
    trendConfirmed?.type !== 'boolean' ||
    volumeConfirmed?.type !== 'boolean' ||
    setupQuality?.type !== 'score' ||
    !Array.isArray(setupQuality.criteria) ||
    setupQuality.criteria.length !== SCORE_MAX + 1
  ) {
    throw new Error('The Jev questions do not match the expected schema.');
  }

  // Ensure the exact object sent over HTTP is JSON-compatible.
  JSON.parse(JSON.stringify(payload));
}

function requireApiKey() {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error(
      'AI_GATEWAY_API_KEY is unavailable. Set it in the environment and retry.',
    );
  }
  if (!/^[A-Za-z0-9._~-]+$/.test(apiKey)) {
    throw new Error('AI_GATEWAY_API_KEY has an invalid format.');
  }
  return apiKey;
}

function formatAnswers(payload) {
  const answers = payload?.answers;
  if (
    !answers ||
    typeof answers.action?.choice !== 'string' ||
    typeof answers.trendConfirmed?.probability !== 'number' ||
    typeof answers.volumeConfirmed?.probability !== 'number' ||
    typeof answers.setupQuality?.score !== 'number' ||
    answers.setupQuality.score < 0 ||
    answers.setupQuality.score > SCORE_MAX ||
    !['WATCH', 'READY', 'ENTER', 'AVOID'].includes(answers.action.choice) ||
    answers.trendConfirmed.probability < 0 ||
    answers.trendConfirmed.probability > 1 ||
    answers.volumeConfirmed.probability < 0 ||
    answers.volumeConfirmed.probability > 1
  ) {
    throw new Error('The gateway returned an unexpected response shape.');
  }

  return {
    action: answers.action.choice,
    trendConfirmed: answers.trendConfirmed.probability >= 0.5,
    volumeConfirmed: answers.volumeConfirmed.probability >= 0.5,
    entryQuality: (answers.setupQuality.score / SCORE_MAX) * 100,
  };
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

async function main() {
  validateRequest(request);
  if (process.argv.includes('--validate-request')) {
    console.log(
      `Valid Jev request: POST ${API_URL} with JSON fields model, state, and questions.`,
    );
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
    await writeFile(requestPath, JSON.stringify(request), {
      mode: 0o600,
    });
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
      throw new Error(`Vercel AI Gateway returned HTTP ${status}.`);
    }

    let payload;
    try {
      payload = JSON.parse(await readFile(responsePath, 'utf8'));
    } catch {
      throw new Error('The gateway returned invalid JSON.');
    }
    const evaluation = formatAnswers(payload);
    console.log('Structured Jev evaluation:');
    console.log(JSON.stringify(evaluation, null, 2));
    console.log(
      `Summary: ${evaluation.action}; trend ${evaluation.trendConfirmed ? 'confirmed' : 'not confirmed'}, volume ${evaluation.volumeConfirmed ? 'confirmed' : 'not confirmed'}, entry quality ${evaluation.entryQuality}/100.`,
    );
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

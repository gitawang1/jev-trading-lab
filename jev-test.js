const API_URL = 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model';
const MODEL = 'typesafe-ai/jev';

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
      'Score the overall quality of this fictional setup from 0 (worst) through 10 (best).',
    criteria: Array.from({ length: 11 }, (_, score) => `${score}/10`),
  },
};

function requireApiKey() {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error(
      'AI_GATEWAY_API_KEY is unavailable. Set it in the environment and retry.',
    );
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
    typeof answers.setupQuality?.score !== 'number'
  ) {
    throw new Error('The gateway returned an unexpected response shape.');
  }

  return {
    action: answers.action.choice,
    trendConfirmed: answers.trendConfirmed.probability >= 0.5,
    volumeConfirmed: answers.volumeConfirmed.probability >= 0.5,
    setupQuality: answers.setupQuality.score,
  };
}

async function main() {
  const apiKey = requireApiKey();
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'ai-evaluation-model-specification-version': '4',
      'ai-model-id': MODEL,
    },
    body: JSON.stringify({ state: marketState, questions }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Vercel AI Gateway request failed with HTTP ${response.status}.`);
  }

  const payload = await response.json();
  console.log('FICTIONAL TEST DATA — structured Jev response:');
  console.log(JSON.stringify(formatAnswers(payload), null, 2));
}

main().catch(error => {
  const safeMessage =
    error instanceof Error ? error.message : 'An unknown error occurred.';
  console.error(`Jev test failed safely: ${safeMessage}`);
  process.exitCode = 1;
});


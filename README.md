# Jev via Vercel AI Gateway: minimal proof of concept

This repository contains one small, non-trading test of TypeSafe AI Jev through
Vercel AI Gateway. **Every market value in the script is FICTIONAL TEST DATA.**
The program has no broker, exchange, wallet, live-market-data, order, or trade
integration.

## What it does

`jev-test.js`:

1. Reads the Vercel credential only from `AI_GATEWAY_API_KEY`.
2. Stops before making a request when that variable is absent.
3. Uses `curl` to send a hard-coded fictional PENGU state to `typesafe-ai/jev`.
4. Asks Jev one native choice question (`action`), two native boolean questions
   (`trendConfirmed` and `volumeConfirmed`), and one native score question
   (`setupQuality`, on Jev's native 0–10 rubric).
5. Exposes that fourth answer to the application as `entryQuality`, normalized
   to a 0–100 scale.
6. Prints only whether a response arrived, its status, the structured result, a
   short summary, or safe error information—not request headers, the credential,
   curl diagnostics, or the raw HTTP response.

Jev's native boolean answers are probabilities. This proof of concept converts
each to a JavaScript boolean using `probability >= 0.5`. Jev's score can be
fractional within the 0–10 rubric, so `entryQuality` is calculated by multiplying
the validated native score by 10.

## Why this uses curl

In the Codex setup environment, Node's native `fetch` cannot reliably reach
`ai-gateway.vercel.sh`, including when Node is run with `--use-env-proxy`.
`curl` does reach the endpoint through that environment's configured proxy, so
this environment-specific proof of concept launches curl from Node instead.

The authorization header is delivered through curl's standard input as an
in-memory config directive. The API key is therefore never included in curl's
command-line arguments or a temporary file, and neither headers nor curl's
diagnostic output are printed. Request and response temporary files contain no
credential, use a private temporary directory, and are removed after the run.

## API format verified

The request follows the current Vercel AI SDK v4 Gateway evaluation transport:

- `POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model`
- `Authorization: Bearer <AI_GATEWAY_API_KEY>`
- `ai-evaluation-model-specification-version: 4`
- `ai-model-id: typesafe-ai/jev`
- JSON body: `{ "state": ..., "questions": ... }`

This was checked against Vercel's current
[Gateway evaluation implementation](https://github.com/vercel/ai/blob/main/packages/gateway/src/gateway-evaluation-model.ts),
[evaluation documentation](https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/32-evaluation.mdx),
and the Gateway's live `/v1/models` catalog. The model catalog identifies
`typesafe-ai/jev` as an evaluation model supporting specification v4.

## Secure Setup-phase run

Node.js 20 or later and `curl` are required. There are no package dependencies.
Run the authenticated test only during the secure Setup phase:

```bash
export AI_GATEWAY_API_KEY='your Vercel AI Gateway key'
npm run test:jev
```

Keep the key in the environment. Do not put it in a source file, command-line
argument, or committed `.env` file.

Expected output has this shape (values shown are illustrative, not a stored Jev
response):

```text
HTTP response received: yes
HTTP status: 200
Structured Jev evaluation:
{
  "action": "READY",
  "trendConfirmed": true,
  "volumeConfirmed": true,
  "entryQuality": 75
}
Summary: READY; trend confirmed, volume confirmed, entry quality 75/100.
```

On failure, the script prints response receipt/status information and a short,
safe API or transport error. It deliberately does not print the response body,
request headers, credential, or curl diagnostics. This is decision-support
output over fictional input only; it is not financial advice and cannot execute
a trade.

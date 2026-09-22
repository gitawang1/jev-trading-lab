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
   (`setupQuality`, on a ten-level native 0–9 rubric).
5. Exposes that fourth answer to the application as `entryQuality`, normalized
   to a 0–100 scale.
6. Prints only whether a response arrived, its status, the structured result, a
   short summary, or safe error information—not request headers, the credential,
   curl diagnostics, or the raw HTTP response.

Jev's native boolean answers are probabilities. This proof of concept converts
each to a JavaScript boolean using `probability >= 0.5`. Jev's score can be
fractional within the 0–9 rubric, so `entryQuality` is normalized with
`score / 9 * 100` after validating the native score.

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

The request follows Vercel's current official native Jev HTTP API:

- `POST https://ai-gateway.vercel.sh/v1/evaluate`
- `Authorization: Bearer <AI_GATEWAY_API_KEY>`
- `Content-Type: application/json`
- JSON body: `{ "model": "typesafe-ai/jev", "state": ..., "questions": ... }`

This endpoint and the three-field request schema were checked against Vercel's
current official AI Gateway documentation. The question shapes also follow
Vercel's official [evaluation documentation](https://ai-sdk.dev/docs/ai-sdk-core/evaluation):
choice criteria are a named map, score criteria are ordered levels, and boolean
questions require no criteria.

Validate the complete request locally, without a credential or network request:

```bash
npm run validate:request
```

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

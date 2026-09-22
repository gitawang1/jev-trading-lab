# Jev via Vercel AI Gateway: minimal proof of concept

This repository contains one small, non-trading test of TypeSafe AI Jev through
Vercel AI Gateway. **Every market value in the script is FICTIONAL TEST DATA.**
The program has no broker, exchange, wallet, live-market-data, order, or trade
integration.

## What it does

`jev-test.js`:

1. Reads the Vercel credential only from `AI_GATEWAY_API_KEY`.
2. Stops before making a request when that variable is absent.
3. Sends a hard-coded fictional PENGU state to `typesafe-ai/jev`.
4. Asks Jev one native choice question (`action`), two native boolean questions
   (`trendConfirmed` and `volumeConfirmed`), and one native score question
   (`setupQuality`, on a 0–10 rubric).
5. Prints only the four normalized answers—not request headers, the credential,
   or the raw HTTP response.

Jev's native boolean answers are probabilities. This proof of concept converts
each to a JavaScript boolean using `probability >= 0.5`. The score can be
fractional within the 0–10 rubric.

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

## Run

Node.js 20 or later is required (for built-in `fetch` and request timeouts). No
package installation is needed.

```bash
export AI_GATEWAY_API_KEY='your Vercel AI Gateway key'
npm run test:jev
```

Keep the key in the environment. Do not put it in a source file, command-line
argument, or committed `.env` file. `.env` variants are ignored as a secondary
safeguard.

Expected output has this shape (values shown are illustrative, not a stored Jev
response):

```text
FICTIONAL TEST DATA — structured Jev response:
{
  "action": "READY",
  "trendConfirmed": true,
  "volumeConfirmed": true,
  "setupQuality": 7.5
}
```

On an HTTP error, the script prints only the status code. It deliberately does
not print the response body or any headers. This is decision-support output over
fictional input only; it is not financial advice and cannot execute a trade.

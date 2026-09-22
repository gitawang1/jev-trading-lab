# Jev via Vercel AI Gateway: minimal diagnostic

This repository contains a non-trading proof of concept for TypeSafe AI Jev
through Vercel AI Gateway. It has no broker, exchange, wallet, live-market-data,
order, or trade integration.

## Documented request schema

Vercel's current native Jev HTTP documentation specifies:

- `POST https://ai-gateway.vercel.sh/v1/evaluate`
- `Authorization: Bearer <AI_GATEWAY_API_KEY>`
- `Content-Type: application/json`
- a JSON object with required `model`, `state`, and `questions` fields
- `model`: the Gateway model ID `typesafe-ai/jev`
- `state`: JSON-compatible shared state (a string, object, or array)
- `questions`: a nonempty map whose keys are caller-selected question IDs
- each Boolean question: `type: "boolean"`, `instructions`, and optional
  `criteria` containing only `true` and/or `false` descriptions

The question types are documented in Vercel's official
[AI SDK evaluation documentation](https://ai-sdk.dev/docs/ai-sdk-core/evaluation).
The native HTTP route and envelope are documented in Vercel's official
[AI Gateway Jev documentation](https://vercel.com/docs/ai-gateway/evaluations).

## Diagnosis and minimal test

The prior request used the documented envelope and valid question shapes: one
choice question with a nonempty criteria map, two Boolean questions without
criteria, and one score question with ten ordered criteria. Its object-valued
state was also allowed. Therefore, comparison with the documented schema did
**not** identify the question schema as the cause of the HTTP 400.

To isolate the next secure Setup test from the larger payload, the script now
sends the smallest documented Boolean-only request:

```json
{
  "model": "typesafe-ai/jev",
  "state": "The support agent issued a full refund to the customer.",
  "questions": {
    "refunded": {
      "type": "boolean",
      "instructions": "Was a refund issued?"
    }
  }
}
```

Validate that exact payload locally, without reading a credential or making a
network request:

```bash
npm run validate:request
```

## Secure transport and error handling

The proof of concept preserves the existing curl transport. The authorization
header is delivered to curl through standard input as an in-memory config
directive, so the key is absent from command-line arguments and temporary files.
Request and response files are placed in a private temporary directory and
removed after the run. Curl diagnostics and request headers are never printed.

For a non-2xx response, the script parses the response only as JSON and emits
only safe scalar values from the allowlisted `error.type`, `error.code`,
`error.message`, `type`, `code`, and `message` fields. If none are safely
displayable, it reports that fact without printing the raw response.

## Secure Setup-phase run

Node.js 20 or later and `curl` are required. There are no package dependencies.
Run the authenticated request only during the secure Setup phase:

```bash
export AI_GATEWAY_API_KEY='your Vercel AI Gateway key'
npm run test:jev
```

Keep the key in the environment. Do not put it in source, a command-line
argument, or a committed `.env` file. On success, the result contains the
thresholded Boolean and Jev's native probability:

```text
HTTP response received: yes
HTTP status: 200
Structured Jev evaluation:
{
  "refunded": true,
  "probability": 0.98
}
```

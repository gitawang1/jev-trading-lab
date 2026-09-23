# Jev through Vercel's TypeSafe-compatible API

This repository contains a temporary, minimal diagnostic for TypeSafe AI Jev
through Vercel AI Gateway. It does not call the Gateway-native
`/v1/evaluate` route.

## Documented compatibility request

Vercel documents `https://ai-gateway.vercel.sh/typesafe` as the compatibility
base URL for existing TypeSafe clients. The current official TypeSafe SDK's
`systemOne` implementation appends `POST /v1/systemone`, uses a Bearer API key,
and sends `state`, named `questions`, and a resolved `model`. Consequently, the
diagnostic sends:

```http
POST https://ai-gateway.vercel.sh/typesafe/v1/systemone
Authorization: Bearer <AI_GATEWAY_API_KEY>
Content-Type: application/json
```

```json
{
  "state": "The support agent issued a full refund to the customer.",
  "questions": {
    "refunded": {
      "type": "noul",
      "instructions": "Was a refund issued?"
    }
  },
  "model": "jev-latest"
}
```

The documented TypeSafe response has `answers.refunded.type` equal to `noul`
and `answers.refunded.noul` equal to the probability of a yes answer. Noul does
not have a separate confidence field.

Sources:

- [Vercel AI Gateway TypeSafe compatibility documentation](https://vercel.com/docs/ai-gateway)
- [Official TypeSafe JavaScript SDK](https://github.com/typesafe-ai/typesafe-sdk-js)
- [TypeSafe API documentation](https://docs.typesafe.ai/api)

## Offline validation

Validate the exact request and sample success/error responses without reading a
credential or making a network request:

```bash
npm run validate
```

## Secure Setup-phase run

The authenticated command is intended **only** for secure Setup in a fresh
environment:

```bash
export AI_GATEWAY_API_KEY='your Vercel AI Gateway key'
npm run test:jev
```

The authorization header is passed to curl through an in-memory stdin config,
not argv or a file. The key is removed from curl's environment. Request and raw
response files live in a private temporary directory that is always deleted.
Neither curl diagnostics, headers, nor the raw response are printed.

The only retained artifact is `/tmp/typesafe-jev-test-result.txt` (mode `0600`).
On success it contains the HTTP status, success marker, and the one Noul
probability. On failure it contains only the HTTP status and allowlisted safe
error fields; when none exist it says exactly:

```text
Vercel returned no safely displayable error detail.
```

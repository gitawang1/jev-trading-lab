# Jev through Vercel's TypeSafe-compatible API

This repository contains a fictional, paper-trading diagnostic for TypeSafe AI Jev through Vercel AI Gateway. It does not call the Gateway-native `/v1/evaluate` route and it does not connect to a broker, exchange, wallet, or live market-data source.

## TypeSafe-compatible request

The diagnostic sends:

```http
POST https://ai-gateway.vercel.sh/typesafe/v1/systemone
Authorization: Bearer <AI_GATEWAY_API_KEY>
Content-Type: application/json
```

with model `jev-latest`, a fictional PENGU state, and five independent Noul questions:

- `trendConfirmed`
- `volumeConfirmed`
- `momentumQuality`
- `acceptableChaseRisk`
- `setupQuality`

The fictional state is:

```json
{
  "symbol": "PENGU",
  "price": 0.035,
  "CRSI_3_2_100": 42,
  "above_VWAP": true,
  "above_POC": true,
  "relative_volume": 1.6,
  "five_minute_swing_high_broken": true,
  "one_hour_trend": "bullish",
  "four_hour_trend": "neutral",
  "distance_from_VWAP_percent": 0.7
}
```

This stage intentionally retains the five probabilities individually and does not convert them into BUY/SELL or order-execution instructions.

## Latency measurement

The authenticated curl transaction is timed with `process.hrtime.bigint()`. Timing begins immediately before `spawn('curl', ...)` and ends in curl's close/error handler, before response parsing. The successful sanitized artifact includes:

```text
HTTP status: 200
Result: success
Jev request latency ms: <number>
trendConfirmed.noul: <number>
volumeConfirmed.noul: <number>
momentumQuality.noul: <number>
acceptableChaseRisk.noul: <number>
setupQuality.noul: <number>
```

This is end-to-end curl request latency and therefore includes network/Gateway overhead, not just model inference time.

## Offline validation

```bash
npm run validate
```

Offline validation checks the PENGU request, all five Noul outputs, latency formatting, and sanitized error formatting without reading a credential or sending a network request.

## Secure Setup-phase run

The authenticated command is intended only for secure Setup in a fresh environment:

```bash
export AI_GATEWAY_API_KEY='your Vercel AI Gateway key'
npm run test:jev
```

The authorization header is passed to curl through an in-memory stdin config, not argv or a file. The key is removed from curl's environment. Request and raw response files live in a private temporary directory that is always deleted. Neither curl diagnostics, headers, nor the raw response are printed.

Before an authenticated run, any old `/tmp/typesafe-jev-test-result.txt` is removed so a stale result cannot be mistaken for the current PENGU evaluation. Offline validation does not remove that artifact.

The only retained authenticated-run artifact is `/tmp/typesafe-jev-test-result.txt` (mode `0600`). On failure it contains only the HTTP status and allowlisted safe error fields; when none exist it says exactly:

```text
Vercel returned no safely displayable error detail.
```


## Controlled repeatability benchmark

`jev-benchmark.js` reuses the exact same fictional PENGU state, `jev-latest` model, TypeSafe-compatible endpoint, five Noul questions, curl timing boundary, and credential handling as the single-request diagnostic.

Offline validation makes no authenticated request:

```bash
npm run validate:benchmark
```

The real benchmark is deliberately separate from Setup's single-request health check:

```bash
npm run benchmark:jev
```

**The real benchmark makes exactly 10 authenticated Jev requests, sequentially.** Each request is timed independently with `process.hrtime.bigint()`. Per-run output records sanitized status, latency, and the five Noul values. Failed requests are recorded with allowlisted safe error details and the remaining runs continue.

Successful runs are summarized with latency minimum, maximum, mean, median, and nearest-rank P95. For 10 successful runs, nearest-rank P95 selects rank `ceil(0.95 × 10) = 10`, the slowest observation. Each Noul is summarized with minimum, maximum, mean, median, population standard deviation, and range (`max - min`).

Before an authenticated benchmark, any old `/tmp/typesafe-jev-benchmark-result.txt` is removed. The sanitized benchmark artifact is written atomically with mode `0600`. Raw request/response bodies, authorization headers, API keys, and proxy credentials are never included in the artifact. Each run uses a private temporary directory that is removed in `finally`; the API key is passed to curl via stdin configuration and removed from curl's child environment.

This benchmark evaluates model repeatability only. It is paper-trading/model-evaluation infrastructure and does not produce BUY, SELL, ENTER, EXIT, position-size, stop-loss, broker, exchange, wallet, or live-market actions.

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


## Synthetic sensitivity test

`jev-sensitivity.js` evaluates 10 fictional scenarios sequentially: the unchanged PENGU baseline plus nine one-variable perturbations. The five original Noul questions and `jev-latest` model are unchanged. Scenarios test CRSI 78, relative volume 0.7, below VWAP, no 5-minute swing-high breakout, bearish 1-hour trend, bullish 4-hour trend, 4.0% distance from VWAP, relative volume 2.5, and CRSI 25.

Offline validation:

```bash
npm run validate:sensitivity
```

Authenticated sensitivity run:

```bash
npm run sensitivity:jev
```

The authenticated command makes exactly 10 sequential Jev requests and writes the sanitized artifact to `/tmp/typesafe-jev-sensitivity-result.txt`. It reports all five Noul values for each scenario and each value's delta versus the baseline. Predeclared directional hypotheses are reported as `satisfied`, `not_satisfied`, or `unchanged`; the CRSI-25 scenario is deliberately exploratory.

The hypotheses are diagnostic expectations, not trading rules or order instructions. Security handling matches the other authenticated diagnostics: the API key is passed to curl through stdin config rather than argv, removed from curl's child environment, raw request/response files are private and deleted, and only sanitized results persist.

## Offline NVDA historical predictive validation

The historical pipeline is entirely offline: it reads a local five-minute OHLCV CSV and never contacts Jev, a market-data vendor, broker, exchange, or any other network service. Headers are matched case-insensitively and must include `timestamp`, `open`, `high`, `low`, `close`, and `volume`. Malformed rows and duplicate normalized timestamps are omitted and itemized in the report.

Run its deterministic anti-look-ahead suite:

```bash
npm run test:historical
```

Generate `historical-features.csv`, `historical-outcomes.csv`, and `historical-validation-report.txt` in the current directory:

```bash
npm run historical:generate -- --input ./NVDA-5m.csv \
  --timestamp-semantics open \
  --input-timezone America/New_York \
  --exchange-timezone America/New_York \
  --session regular \
  --symbol NVDA
```

Use `--timestamp-semantics close` for close-stamped data. Open stamps normalize to `barOpen = timestamp`, `barClose = timestamp + 5 minutes`; close stamps normalize to `barClose = timestamp`, `barOpen = timestamp - 5 minutes`. A timestamp carrying no UTC offset requires the explicit IANA `--input-timezone`. Observation timestamps and stable IDs use normalized `barClose`, when the feature first becomes available. `--exchange-timezone` defaults to `America/New_York`; session membership is determined after IANA-zone conversion, including historical DST. `--session regular` selects 09:30–16:00 and `--session extended` selects 04:00–20:00 exchange-local time.

### Exact feature definitions

Connors RSI is exactly CRSI(3,2,100): Wilder RSI(3) of close, Wilder RSI(2) of the signed consecutive-close streak (unchanged resets to zero), and the rank of the current one-bar percentage return in the last 100 returns, including itself. Percent rank is `strictly-lower count + 0.5 × exact-tie count` (equivalently that value as a percentage of the 100-element window). These three values are averaged without substituting another platform's definition.

Session VWAP is the volume-weighted mean of `(high + low + close) / 3` and resets for every selected exchange-local session. `above_VWAP` is 1 only when close is greater than VWAP. VWAP distance is signed: `((close - VWAP) / VWAP) × 100`.

Version 1 `relative_volume` is a **same-session rolling 20-bar proxy**: current volume divided by the mean of the previous 20 completed eligible bars. It excludes the current bar and never crosses a session. It is not conventional same-time-of-day RVOL; with five-minute regular-hours data it creates an approximately 100-minute opening warm-up. A separately named, time-of-day-normalized RVOL may be added in the future, but is not implemented here. The swing feature likewise compares the current close with the highest high of exactly the previous five same-session completed bars, excluding the current bar.

One-hour and four-hour candles are bucketed from the selected session's exchange-local opening time using normalized bar-open times. Only complete buckets containing exact consecutive five-minute bars can update EMA20/EMA50; a candle still forming at the observation close is unavailable. Trend is +1 for `close > EMA20 > EMA50`, -1 for `close < EMA20 < EMA50`, and 0 otherwise.

The explicit Jev-safe projection contains only `timestamp`, `symbol`, `price`, `crsi`, `relative_volume`, `above_VWAP`, `distance_from_VWAP_percent`, `five_minute_swing_high_broken`, `trend_1h`, and `trend_4h`. Outcome labels never enter it. `observation_id` is emitted solely as CSV join metadata and does not expand that allowlist.

### Labels and diagnostic

Forward returns use the closes exactly 1, 3, 6, and 12 completed five-minute bars after the observation (5, 15, 30, and 60 minutes). MFE/MAE for 15, 30, and 60 minutes use, respectively, the highs/lows of future bars `t+1..t+3`, `t+1..t+6`, and `t+1..t+12`; the time-t bar is excluded. Every step must be exactly five minutes apart and in the same configured exchange-local session. Otherwise the observation has insufficient future bars and is not output. Labels are calculated separately and never feed time-t features.

Inspect CRSI components for an emitted observation:

```bash
npm run historical:diagnostic -- --input ./NVDA-5m.csv \
  --timestamp-semantics open --input-timezone America/New_York \
  --session regular --observation-id NVDA-2024-01-02T15:35:00.000Z
```

`--timestamp 2024-01-02T15:35:00.000Z` may be used instead. The command prints price RSI(3), current streak, streak RSI(2), one-bar return, 100-return percent rank, and final CRSI.

### Calendar and data limitations

This implementation deliberately does **not** invent an exchange calendar. Time-of-day sessions are recognized, but exchange holidays, early closes, unscheduled closures, and missing vendor bars are not inferred or repaired. Exact-spacing/full-bucket rules prevent gaps from being treated as complete higher-timeframe bars or future horizons; users must interpret exclusions in light of their vendor data and the actual historical exchange calendar. Exclusion categories in the report can overlap during feature warm-up; the insufficient-future category is evaluated only after all feature requirements pass.

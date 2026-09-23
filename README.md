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

## Offline historical validation

The historical validator is deliberately local-only. Its defaults model NVDA and
other US equities with the IANA timezone `America/New_York`:

- regular session: `09:30-16:00 America/New_York`;
- extended session: `04:00-20:00 America/New_York`.

Session membership is never determined from UTC wall-clock values. An input
timestamp with `Z` or a numeric offset identifies an instant directly. An input
without an offset is interpreted in `--input-timezone` (default `UTC`). That
normalized instant is then converted through `Intl`'s IANA timezone data into
`--exchange-timezone` (default `America/New_York`) before it is compared with
the selected session. Consequently, the New York open remains 09:30 across
historical EST/EDT offset changes.

Input is a JSON array whose records contain `timestamp` and numeric `volume`:

```bash
node historical-validation.js \
  --input bars.json \
  --input-timezone UTC \
  --exchange-timezone America/New_York \
  --session regular \
  --bar-timestamp open \
  --bar-minutes 5
```

Session bounds are start-inclusive and end-exclusive. With
`--bar-timestamp open`, the timestamp is the opening instant of a bar. With
`--bar-timestamp close`, the validator subtracts `--bar-minutes` to classify
the bar by its opening instant; therefore a five-minute bar stamped `16:00`
belongs to the regular session, while one stamped `09:30` does not.

The relative-volume value remains the **same-session rolling 20-bar relative-volume
proxy**: current volume divided by the mean of the preceding 20 eligible bars
from the same exchange-local date. It is not a time-of-day-normalized RVOL.
For five-minute bars in regular-session mode, the proxy imposes an approximately
100-minute opening-session warm-up before an observation can become eligible.
A future, separately named time-of-day-normalized RVOL variant may be needed to
evaluate opening-session setups without that warm-up; this repository does not
implement that alternative.

The validator does **not** invent an exchange calendar. Weekends, exchange
holidays, unscheduled closures, and early closes are not modeled. Input data
must be filtered appropriately until the historical market-data provider and
its calendar semantics are selected.

Run the deterministic offline checks (including dates before and after both US
daylight-saving transitions) with:

```bash
npm run validate:historical
```

See [`HISTORICAL_VALIDATION_REPORT.md`](HISTORICAL_VALIDATION_REPORT.md) for the
methodology and remaining assumptions.

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

# Frozen JEV V3 HMA20 / session POC module

This module is an independent, causal implementation of the October 5–6, 2026 NVDA-development specification.

- HMA20: WMA4(2×WMA10(close) − WMA20(close)); HMA continuity across sessions, slopes reset at New York session boundary.
- Volume profile: session-to-date, $0.25 bins, high-low proportional volume allocation, 70% value area.
- POC: center of the highest-volume bin; equal-volume ties choose the lower-price bin.
- Value area: expand from POC toward the larger-volume neighboring bin; equal-volume ties choose lower-price neighbor.
- Nine-state ordered first-match classifier: frozen HMA and Jev thresholds, missing inputs are unclassifiable.
- No forward outcomes, trading recommendations, AMD tuning, or API calls.

## Run tests
```sh
cd jev-v3
python -m unittest -v test_features.py
```

## Generate features
```sh
python jev-v3/jev_v3_features.py --input canonical-five-minute.csv --output features.csv
```

Input columns: `timestamp,close,high,low,volume`, chronologically ordered, timezone-aware ISO timestamps.

## Research safeguards

This branch adds a module and a CI test workflow only. It does not change the pinned historical engine, Jev scoring, AMD outcome handling, or existing workflows. Do not merge into production research workflows until NVDA reference comparisons are independently reproduced and reviewed.

**Important:** The stored NVDA V3 dataset was used as a development reference, not a new out-of-sample performance test. The original value-area implementation provenance is not independently established by the frozen specification alone. Any divergence requires documented investigation before cross-asset application.

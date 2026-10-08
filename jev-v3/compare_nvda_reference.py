"""Strict comparison of canonical five-minute calculations with frozen NVDA V3 rows.

No future-return labels are loaded. Fail closed on missing rows, duplicates,
missing feature values, nonfinite numbers, and deviations beyond tolerance.
"""
import argparse
import csv
import math
from datetime import datetime, timezone
from jev_v3_features import generate

FIELDS = ("canonical_close", "hma20", "hma20_d1_per5m",
          "poc_stod", "val_stod", "vah_stod",
          "dist_close_to_poc_pct", "va_concentration")

def key(value):
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("Naive timestamp")
    return dt.astimezone(timezone.utc)

def load(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))

def compare(canonical, reference, tol=1e-8, expected=2554):
    if len(reference) != expected:
        raise AssertionError(f"Expected {expected} frozen reference rows, found {len(reference)}")
    keys = [key(r["timestamp"]) for r in reference]
    if len(set(keys)) != len(keys):
        raise AssertionError("Duplicate frozen reference timestamps")
    rows = list(generate(canonical))
    produced = {key(r["timestamp"]): r for r in rows}
    if len(produced) != len(rows):
        raise AssertionError("Duplicate generated timestamps")
    worst = {f: 0.0 for f in FIELDS}
    for ref_key, ref in zip(keys, reference):
        if ref_key not in produced:
            raise AssertionError(f"Missing canonical timestamp {ref_key}")
        actual = produced[ref_key]
        for field in FIELDS:
            a = ref.get(field)
            b = actual.get(field)
            if a in (None, "") or b in (None, ""):
                if a in (None, "") and b in (None, ""):
                    continue
                raise AssertionError(f"Missing mismatch at {ref_key}: {field}: {a} != {b}")
            a, b = float(a), float(b)
            if not math.isfinite(a) or not math.isfinite(b):
                raise AssertionError(f"Nonfinite {field} at {ref_key}")
            delta = abs(a - b)
            worst[field] = max(worst[field], delta)
            if delta > tol:
                raise AssertionError(f"{field} at {ref_key}: {a} != {b}; delta {delta}")
    return worst

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--canonical", required=True)
    p.add_argument("--reference", required=True)
    p.add_argument("--tolerance", type=float, default=1e-8)
    p.add_argument("--expected-rows", type=int, default=2554)
    args = p.parse_args()
    if args.tolerance <= 0:
        p.error("Tolerance must be positive")
    worst = compare(load(args.canonical), load(args.reference),
                    args.tolerance, args.expected_rows)
    print(f"PASS: {args.expected_rows} frozen NVDA V3 observations compared")
    for field, delta in worst.items():
        print(f"{field}: maximum absolute difference {delta:.12g}")

if __name__ == "__main__":
    main()

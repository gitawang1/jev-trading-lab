"""Frozen JEV V3 causal HMA20 and session-to-date volume profile.
No future outcomes. Value-area tie rules are explicit implementation choices.
"""
import argparse
import csv
import math
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
WIDTH = 0.25
H_EPS = 0.017367011255413428
J_EPS = 0.005000000000000001

def wma(values, n):
    if len(values) < n or any(v is None for v in values[-n:]):
        return None
    return sum((i + 1) * v for i, v in enumerate(values[-n:])) / (n * (n + 1) / 2)

def hma20_series(closes):
    diffs, output = [], []
    for i in range(len(closes)):
        a, b = wma(closes[:i + 1], 10), wma(closes[:i + 1], 20)
        diffs.append(None if a is None or b is None else 2 * a - b)
        output.append(wma(diffs, 4))
    return output

def profile_update(profile, high, low, volume, width=WIDTH):
    if not all(math.isfinite(v) for v in (high, low, volume)) or volume < 0 or high < low:
        raise ValueError("Invalid OHLCV bar")
    if high == low:
        profile[math.floor(low / width)] += volume
        return
    for idx in range(math.floor(low / width), math.ceil(high / width)):
        overlap = max(0.0, min(high, (idx + 1) * width) - max(low, idx * width))
        if overlap:
            profile[idx] += volume * overlap / (high - low)

def profile_metrics(profile, width=WIDTH, fraction=0.7):
    total = sum(profile.values())
    if not profile or total <= 0:
        return None
    poc = min(profile, key=lambda k: (-profile[k], k))
    left = right = poc
    accumulated = profile[poc]
    while accumulated / total < fraction:
        lv, rv = profile.get(left - 1, 0.0), profile.get(right + 1, 0.0)
        if lv == rv == 0:
            break
        if lv >= rv:
            left -= 1
            accumulated += lv
        else:
            right += 1
            accumulated += rv
    return {"poc_stod": (poc + 0.5) * width,
            "val_stod": left * width, "vah_stod": (right + 1) * width,
            "va_concentration": accumulated / total}

def classify(h, j, p):
    if any(v is None or not math.isfinite(v) for v in (h, j, p)):
        return "unclassifiable"
    if h > H_EPS and j > J_EPS and p >= 0: return "bullish_expansion"
    if h > H_EPS and j >= -J_EPS: return "bullish_continuation"
    if h > H_EPS and j < -J_EPS: return "bullish_divergence"
    if h < -H_EPS and j < -J_EPS and p <= 0: return "bearish_expansion"
    if h < -H_EPS and j <= J_EPS: return "bearish_continuation"
    if h < -H_EPS and j > J_EPS: return "bearish_divergence"
    if abs(h) <= H_EPS and j > J_EPS: return "recovery_pressure"
    if abs(h) <= H_EPS and j < -J_EPS: return "deterioration_pressure"
    return "neutral_transition"

def parse_time(s):
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("Timestamp must include timezone")
    return dt

def generate(rows):
    closes = [float(row["close"]) for row in rows]
    hmas = hma20_series(closes)
    session = None
    profile = defaultdict(float)
    prev_hma = prev_poc = None
    for i, row in enumerate(rows):
        local = parse_time(row["timestamp"]).astimezone(NY)
        current = local.date().isoformat()
        if current != session:
            session = current
            profile = defaultdict(float)
            prev_hma = prev_poc = None
        close = closes[i]
        profile_update(profile, float(row["high"]), float(row["low"]), float(row["volume"]))
        metrics = profile_metrics(profile)
        hma = hmas[i]
        hd1 = None if hma is None or prev_hma is None else hma - prev_hma
        poc = metrics["poc_stod"] if metrics else None
        pd1 = None if poc is None or prev_poc is None else poc - prev_poc
        yield {"timestamp": row["timestamp"], "session": session, "canonical_close": close,
               "hma20": hma, "hma20_d1_per5m": hd1,
               "poc_stod": poc,
               "val_stod": metrics["val_stod"] if metrics else None,
               "vah_stod": metrics["vah_stod"] if metrics else None,
               "va_concentration": metrics["va_concentration"] if metrics else None,
               "dist_close_to_poc_pct": (100 * (close - poc) / close if poc is not None and close else None),
               "poc_d1_per5m": pd1}
        prev_hma, prev_poc = hma, poc

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    with open(args.input, newline="") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise SystemExit("No input bars")
    timestamps = [parse_time(r["timestamp"]) for r in rows]
    if any(a >= b for a, b in zip(timestamps, timestamps[1:])):
        raise SystemExit("Timestamps must be strictly increasing")
    with open(args.output, "w", newline="") as f:
        fields = ["timestamp", "session", "canonical_close", "hma20", "hma20_d1_per5m",
                  "poc_stod", "val_stod", "vah_stod", "va_concentration",
                  "dist_close_to_poc_pct", "poc_d1_per5m"]
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(generate(rows))

if __name__ == "__main__":
    main()

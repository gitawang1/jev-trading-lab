import unittest
from collections import defaultdict
from jev_v3_features import hma20_series, profile_update, profile_metrics, classify, generate

class FeatureTests(unittest.TestCase):
    def test_hma_warmup_and_constant(self):
        values = hma20_series([10.0] * 40)
        self.assertTrue(all(v is None for v in values[:22]))
        self.assertTrue(all(abs(v - 10) < 1e-10 for v in values[22:]))

    def test_overlap_conserves_volume(self):
        p = defaultdict(float)
        profile_update(p, 100.6, 100.1, 500)
        self.assertAlmostEqual(sum(p.values()), 500)
        self.assertAlmostEqual(profile_metrics(p)["poc_stod"], 100.375)

    def test_zero_range(self):
        p = defaultdict(float)
        profile_update(p, 100, 100, 25)
        self.assertEqual(sum(p.values()), 25)

    def test_missing_jev_is_unclassifiable(self):
        self.assertEqual(classify(0.2, None, 0.1), "unclassifiable")

    def test_nine_states(self):
        cases = [
            (0.1, 0.1, 1, "bullish_expansion"),
            (0.1, 0, -1, "bullish_continuation"),
            (0.1, -0.1, 1, "bullish_divergence"),
            (-0.1, -0.1, -1, "bearish_expansion"),
            (-0.1, 0, 1, "bearish_continuation"),
            (-0.1, 0.1, -1, "bearish_divergence"),
            (0, 0.1, 0, "recovery_pressure"),
            (0, -0.1, 0, "deterioration_pressure"),
            (0, 0, 0, "neutral_transition"),
        ]
        for h, j, p, expected in cases:
            self.assertEqual(classify(h, j, p), expected)

    def test_session_reset(self):
        rows = [
            {"timestamp": "2026-10-05T19:55:00Z", "close": "100", "high": "100.1", "low": "99.9", "volume": "100"},
            {"timestamp": "2026-10-06T13:30:00Z", "close": "101", "high": "101.1", "low": "100.9", "volume": "100"},
        ]
        result = list(generate(rows))
        self.assertNotEqual(result[0]["session"], result[1]["session"])
        self.assertIsNone(result[1]["poc_d1_per5m"])

if __name__ == "__main__":
    unittest.main()

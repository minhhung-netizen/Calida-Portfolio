"""Behavior when the optional Vnstock package is unavailable in a deploy image."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


PIPELINE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PIPELINE_DIR))
import fetch_prices  # noqa: E402


class FetchPricesTest(unittest.TestCase):
    def test_request_pacer_is_sequential_and_clamped_below_provider_limit(self):
        state = {"now": 0.0}
        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            state["now"] += seconds

        pacer = fetch_prices._RequestPacer(60, clock=lambda: state["now"], sleeper=sleep)
        self.assertEqual(pacer.requests_per_minute, 55)
        pacer.wait()
        pacer.wait()
        pacer.wait()
        self.assertEqual(len(sleeps), 2)
        self.assertAlmostEqual(sleeps[0], 60 / 55)
        self.assertAlmostEqual(sleeps[1], 60 / 55)

    def test_missing_vnstock_skips_price_refresh_without_retries(self):
        with patch("fetch_prices.find_spec", return_value=None):
            self.assertEqual(fetch_prices.run(), ["vnstock"])

    def test_active_personal_alerts_add_tickers_to_price_source(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(fetch_prices, "DATA_DIR", Path(directory)):
            payload = {"alerts": [
                {"ticker": "vnm", "enabled": True},
                {"ticker": "hpg", "enabled": False},
            ]}
            (Path(directory) / "price-alerts.json").write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(fetch_prices._manual_alert_tickers(), {"VNM"})


if __name__ == "__main__":
    unittest.main()

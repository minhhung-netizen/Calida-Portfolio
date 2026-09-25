"""Kiểm thử luồng lấy giá tuần tự và báo giá trong phiên."""
import json
import sys
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

import pandas as pd


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

    def test_missing_vnstock_fails_loudly_instead_of_leaving_stale_prices(self):
        with patch("fetch_prices.find_spec", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "Thiếu thư viện vnstock"):
                fetch_prices.run()

    def test_guest_mode_is_throttled_below_twenty_requests_per_minute(self):
        with patch.dict("fetch_prices.os.environ", {}, clear=True), \
                patch("fetch_prices.find_spec", return_value=object()), \
                patch("fetch_prices._RequestPacer") as pacer, \
                patch("fetch_prices.read_sheet", return_value=pd.DataFrame({"ticker": []})), \
                patch("fetch_prices._history", side_effect=RuntimeError("nguồn thử nghiệm")), \
                patch("fetch_prices.time.sleep"):
            pacer.return_value.requests_per_minute = 18
            fetch_prices.run(retries=1)
            pacer.assert_called_once_with(18)

    def test_active_personal_alerts_add_tickers_to_price_source(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(fetch_prices, "DATA_DIR", Path(directory)):
            payload = {"alerts": [
                {"ticker": "vnm", "enabled": True},
                {"ticker": "hpg", "enabled": False},
            ]}
            (Path(directory) / "price-alerts.json").write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(fetch_prices._manual_alert_tickers(), {"VNM"})

    def test_current_quote_is_written_as_today_price_in_thousand_vnd(self):
        timestamp = int(datetime(2026, 9, 25, 10, 15, tzinfo=ZoneInfo("Asia/Ho_Chi_Minh")).timestamp() * 1000)
        quote = pd.DataFrame([{
            "symbol": "FPT", "time": timestamp, "open_price": 65500,
            "high_price": 65900, "low_price": 65000, "close_price": 65200,
            "volume_accumulated": 1_061_600,
        }])
        with patch.object(fetch_prices, "VNSTOCK_QUOTE_PRICE_DIVISOR", 1000):
            result = fetch_prices._normalize_current_quote("FPT", quote, today=date(2026, 9, 25))
        row = result.iloc[0]
        self.assertEqual(row.ticker, "FPT")
        self.assertEqual(row.date.date(), date(2026, 9, 25))
        self.assertEqual(row.close, 65.2)
        self.assertEqual(row.high, 65.9)
        self.assertEqual(row.volume, 1_061_600)

    def test_stale_current_quote_is_rejected(self):
        timestamp = int(datetime(2026, 9, 24, 15, 0, tzinfo=ZoneInfo("Asia/Ho_Chi_Minh")).timestamp() * 1000)
        quote = pd.DataFrame([{"symbol": "FPT", "time": timestamp, "close_price": 65200}])
        with self.assertRaisesRegex(ValueError, "chưa có dữ liệu 2026-09-25"):
            fetch_prices._normalize_current_quote("FPT", quote, today=date(2026, 9, 25))


if __name__ == "__main__":
    unittest.main()

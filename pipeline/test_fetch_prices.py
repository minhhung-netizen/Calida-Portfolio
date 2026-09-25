"""Behavior when the optional Vnstock package is unavailable in a deploy image."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


PIPELINE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PIPELINE_DIR))
import fetch_prices  # noqa: E402


class FetchPricesTest(unittest.TestCase):
    def test_missing_vnstock_skips_price_refresh_without_retries(self):
        with patch("fetch_prices.find_spec", return_value=None):
            self.assertEqual(fetch_prices.run(), ["vnstock"])


if __name__ == "__main__":
    unittest.main()

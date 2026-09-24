"""Regression tests for the project-wide Google Sheets number convention."""
import sys
import unittest
from pathlib import Path

import pandas as pd


PIPELINE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PIPELINE_DIR))
from number_normalizer import format_number, normalize_number_text, parse_number  # noqa: E402
from fetch_gsheets import apply_map  # noqa: E402


class NumberNormalizerTest(unittest.TestCase):
    def test_prefers_canonical_grouping_and_decimal_marks(self):
        self.assertEqual(parse_number("1,234.56"), 1234.56)
        self.assertEqual(parse_number("12.5"), 12.5)
        self.assertEqual(parse_number("-1,234.50"), -1234.5)
        self.assertTrue(pd.isna(parse_number("N/A")))

    def test_keeps_legacy_vietnamese_values_readable_during_migration(self):
        self.assertEqual(parse_number("1.234,56"), 1234.56)
        self.assertEqual(parse_number("12,5"), 12.5)
        self.assertEqual(parse_number("1.234.567"), 1234567)
        self.assertEqual(parse_number("-1.234.567"), -1234567)
        self.assertEqual(parse_number("1.234 tỷ"), 1234)
        self.assertEqual(parse_number("+12,5%"), 12.5)

    def test_formats_ranges_for_api_consumers(self):
        self.assertEqual(format_number(1234.5), "1,234.5")
        self.assertEqual(normalize_number_text("25,0 – 26,2"), "25 – 26.2")
        self.assertEqual(normalize_number_text("1,234.50"), "1,234.5")

    def test_google_sheet_import_normalizes_the_canonical_format(self):
        book = {"FUND": pd.DataFrame([{
            "Kỳ": "08/2026", "Mã quỹ": "VFM", "Tên quỹ": "Quỹ VFM",
            "NAV": "8,305.50", "YTD": "6.6",
        }])}
        mapping = {"FUND": ("funds.xlsx", "FUND_SUMMARY", {
            "Kỳ": "period", "Mã quỹ": "fund_code", "Tên quỹ": "fund_name",
            "NAV": "nav_bn", "YTD": "ytd_pct",
        }, {})}
        result = apply_map(book, mapping)[("funds.xlsx", "FUND_SUMMARY")]
        self.assertEqual(result.loc[0, "nav_bn"], 8305.5)
        self.assertEqual(result.loc[0, "ytd_pct"], 6.6)


if __name__ == "__main__":
    unittest.main()

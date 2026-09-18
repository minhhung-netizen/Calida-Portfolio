"""Tests for business data-quality gates before dashboard publication."""
import importlib
import sys
import unittest
from pathlib import Path

import pandas as pd


PIPELINE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PIPELINE_DIR))
quality = importlib.import_module("data_quality")


class DataQualityTest(unittest.TestCase):
    def test_detects_invalid_prices_and_orphan_report_rows(self):
        frames = {
            ("market.xlsx", "VNINDEX"): pd.DataFrame([{"date": "2026-09-18", "open": 100, "high": 90, "low": 95, "close": 101, "volume": 1}]),
            ("reports.xlsx", "REPORTS"): pd.DataFrame([{"id": "R1", "type": "Chiến lược", "stance": "Tích cực", "vn_target": 1200}]),
            ("reports.xlsx", "REPORT_STOCKS"): pd.DataFrame([{"report_id": "UNKNOWN", "ticker": "FPT", "rec": "MUA", "target": 100}]),
        }
        issues = quality.validate(frames)
        messages = " ".join(item["message"] for item in issues if item["level"] == "error")
        self.assertIn("thứ tự giá hợp lệ", messages)
        self.assertIn("report_id không tồn tại", messages)
        with self.assertRaises(quality.DataQualityError):
            quality.raise_for_errors(issues)

    def test_current_workbooks_have_no_blocking_issues(self):
        from build_db import to_date
        from schema import SCHEMA

        frames = {}
        root = PIPELINE_DIR.parent / "data" / "input"
        for file, sheets in SCHEMA.items():
            book = pd.read_excel(root / file, sheet_name=None)
            for sheet, spec in sheets.items():
                df = book[sheet].reindex(columns=spec["cols"]).dropna(how="all")
                for column in spec.get("dates", []):
                    df[column] = to_date(df[column]).dt.strftime("%Y-%m-%d")
                frames[(file, sheet)] = df.drop_duplicates(subset=spec["key"], keep="last")
        issues = quality.validate(frames)
        self.assertFalse([item for item in issues if item["level"] == "error"], issues)


if __name__ == "__main__":
    unittest.main()

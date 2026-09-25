"""Kiểm thử xoá theo ngày và dấu xoá bền vững."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd


PIPELINE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PIPELINE_DIR))
import data_admin  # noqa: E402
from schema import SCHEMA  # noqa: E402


def empty_frame(file, sheet):
    return pd.DataFrame(columns=SCHEMA[file][sheet]["cols"])


class DataAdminTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Path(self.temp.name) / "data-deletions.json"
        self.store_patch = patch.object(data_admin, "DELETE_STORE", self.store)
        self.store_patch.start()

    def tearDown(self):
        self.store_patch.stop()
        self.temp.cleanup()

    def test_purge_news_date_persists_tombstone(self):
        frames = {
            ("market.xlsx", "VIEW"): empty_frame("market.xlsx", "VIEW"),
            ("market.xlsx", "NEWS"): pd.DataFrame([
                {"published_at": "2026-09-01 08:00:00", "tab": "Trong nước", "title": "Tin cũ", "source": "Test", "url": ""},
                {"published_at": "2026-09-02 08:00:00", "tab": "Trong nước", "title": "Tin mới", "source": "Test", "url": ""},
            ]),
            ("market.xlsx", "EVENTS"): pd.DataFrame([
                {"date": "2026-09-01", "time": "09:00", "name": "Sự kiện giữ lại", "country": "VN", "impact": "Cao", "forecast": "", "previous": ""},
            ]),
        }
        written = {}
        with patch.object(data_admin, "_module_frames", return_value={key: value.copy() for key, value in frames.items()}), \
             patch.object(data_admin, "write_sheets", side_effect=lambda file, values: written.update(values)):
            event = data_admin.purge("brief", "2026-09-01", "2026-09-01", "admin", "news")
        self.assertEqual(event["rows"], 1)
        self.assertEqual(written["NEWS"].title.tolist(), ["Tin mới"])
        self.assertEqual(written["EVENTS"].name.tolist(), ["Sự kiện giữ lại"])

        reimported = {("market.xlsx", "NEWS"): frames[("market.xlsx", "NEWS")].copy()}
        self.assertEqual(data_admin.apply_tombstones(reimported), 1)
        self.assertEqual(reimported[("market.xlsx", "NEWS")].title.tolist(), ["Tin mới"])

    def test_report_date_cascades_to_child_rows(self):
        frames = {
            ("reports.xlsx", "REPORTS"): pd.DataFrame([
                {"id": "R1", "broker": "A", "date": "2026-09-01", "type": "Chiến lược", "title": "Cũ", "stance": "Trung lập", "vn_target": None, "horizon": "", "summary": "", "source": ""},
                {"id": "R2", "broker": "A", "date": "2026-09-02", "type": "Chiến lược", "title": "Mới", "stance": "Trung lập", "vn_target": None, "horizon": "", "summary": "", "source": ""},
            ]),
            ("reports.xlsx", "REPORT_STOCKS"): pd.DataFrame([
                {"report_id": "R1", "ticker": "FPT", "rec": "MUA", "target": 100},
                {"report_id": "R2", "ticker": "VCB", "rec": "MUA", "target": 80},
            ]),
            ("reports.xlsx", "REPORT_SECTORS"): empty_frame("reports.xlsx", "REPORT_SECTORS"),
            ("reports.xlsx", "REPORT_RISKS"): empty_frame("reports.xlsx", "REPORT_RISKS"),
        }
        written = {}
        with patch.object(data_admin, "_module_frames", return_value={key: value.copy() for key, value in frames.items()}), \
             patch.object(data_admin, "write_sheets", side_effect=lambda file, values: written.update(values)):
            event = data_admin.purge("reports", "2026-09-01", "2026-09-01", "admin", "reports")
        self.assertEqual(event["rows"], 2)
        self.assertEqual(written["REPORTS"].id.tolist(), ["R2"])
        self.assertEqual(written["REPORT_STOCKS"].report_id.tolist(), ["R2"])


if __name__ == "__main__":
    unittest.main()

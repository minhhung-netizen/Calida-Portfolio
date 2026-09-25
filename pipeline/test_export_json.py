"""Kiểm thử dữ liệu lịch sử của module Quỹ khi xuất dashboard."""
import importlib
import sqlite3
import sys
import unittest
from pathlib import Path


PIPELINE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PIPELINE_DIR))
export_json = importlib.import_module("export_json")


class FundPeriodExportTest(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.executescript("""
            CREATE TABLE fund_summary (period TEXT, fund_code TEXT, fund_name TEXT, nav_bn REAL, ytd_pct REAL);
            CREATE TABLE asset_allocation (period TEXT, fund_code TEXT, asset_type TEXT, weight_pct REAL);
            CREATE TABLE industry (period TEXT, fund_code TEXT, industry TEXT, weight_pct REAL);
            CREATE TABLE top_holdings (period TEXT, fund_code TEXT, ticker TEXT, weight_pct REAL);
        """)
        for period, nav, stock, cash in (("07/2026", 100, 80, 20), ("08/2026", 120, 85, 15)):
            self.con.execute("INSERT INTO fund_summary VALUES (?, 'FUND-A', 'Quỹ A', ?, 5)", (period, nav))
            self.con.execute("INSERT INTO asset_allocation VALUES (?, 'FUND-A', 'Cổ phiếu', ?)", (period, stock))
            self.con.execute("INSERT INTO asset_allocation VALUES (?, 'FUND-A', 'Tiền mặt', ?)", (period, cash))
            self.con.execute("INSERT INTO industry VALUES (?, 'FUND-A', 'Ngân hàng', ?)", (period, stock))
            self.con.execute("INSERT INTO top_holdings VALUES (?, 'FUND-A', 'VCB', 10)", (period,))

    def tearDown(self):
        self.con.close()

    def test_exports_every_period_newest_first(self):
        data = export_json.funds(self.con)
        self.assertEqual(data["period"], "08/2026")
        self.assertEqual([item["period"] for item in data["periods"]], ["08/2026", "07/2026"])
        self.assertEqual(data["periods"][0]["prevPeriod"], "07/2026")
        self.assertIsNone(data["periods"][1]["prevPeriod"])
        self.assertEqual(data["periods"][0]["nav"], 120.0)
        self.assertEqual(data["periods"][1]["nav"], 100.0)


if __name__ == "__main__":
    unittest.main()

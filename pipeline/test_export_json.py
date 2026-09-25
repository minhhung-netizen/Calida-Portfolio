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
            CREATE TABLE prices (date TEXT, ticker TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL);
            CREATE TABLE investor_flow (date TEXT);
            CREATE TABLE vnindex (date TEXT);
            CREATE TABLE view (date TEXT);
        """)
        for period, nav, stock, cash in (("07/2026", 100, 80, 20), ("08/2026", 120, 85, 15)):
            self.con.execute("INSERT INTO fund_summary VALUES (?, 'FUND-A', 'Quỹ A', ?, 5)", (period, nav))
            self.con.execute("INSERT INTO asset_allocation VALUES (?, 'FUND-A', 'Cổ phiếu', ?)", (period, stock))
            self.con.execute("INSERT INTO asset_allocation VALUES (?, 'FUND-A', 'Tiền mặt', ?)", (period, cash))
            self.con.execute("INSERT INTO industry VALUES (?, 'FUND-A', 'Ngân hàng', ?)", (period, stock))
            self.con.execute("INSERT INTO top_holdings VALUES (?, 'FUND-A', 'VCB', 10)", (period,))
        self.con.execute("INSERT INTO prices VALUES ('2026-09-23', 'VNM', 60, 62, 59, 61, 1000)")
        self.con.execute("INSERT INTO prices VALUES ('2026-09-24', 'VNM', 61, 64, 60, 63, 1200)")

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

    def test_exports_latest_price_for_alert_tickers_outside_portfolio(self):
        prices = export_json.latest_prices(self.con, "2026-09-24")
        self.assertEqual(prices, [{"t": "VNM", "price": 63.0, "previousPrice": 61.0, "chg": 2.0, "date": "2026-09-24"}])

    def test_dashboard_date_includes_new_intraday_prices(self):
        self.con.execute("INSERT INTO vnindex VALUES ('2026-09-24')")
        self.con.execute("INSERT INTO view VALUES ('2026-09-24')")
        self.assertEqual(export_json.dashboard_as_of(self.con), "2026-09-24")
        self.con.execute("INSERT INTO prices VALUES ('2026-09-25', 'FPT', 65, 66, 64, 65.2, 2000)")
        self.assertEqual(export_json.dashboard_as_of(self.con), "2026-09-25")


if __name__ == "__main__":
    unittest.main()

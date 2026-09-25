"""Kiểm thử cập nhật riêng bảng giá không dựng lại các module khác."""
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd


PIPELINE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PIPELINE_DIR))
import build_db  # noqa: E402


class RefreshPricesTest(unittest.TestCase):
    def test_refresh_prices_preserves_unrelated_tables(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_dir = root / "input"
            input_dir.mkdir()
            database = root / "calida.db"
            with pd.ExcelWriter(input_dir / "market.xlsx", engine="openpyxl") as writer:
                pd.DataFrame([{
                    "date": "2026-09-25", "open": 1700, "high": 1710,
                    "low": 1690, "close": 1705, "volume": 1000,
                }]).to_excel(writer, sheet_name="VNINDEX", index=False)
            with pd.ExcelWriter(input_dir / "portfolio.xlsx", engine="openpyxl") as writer:
                pd.DataFrame([{
                    "date": "2026-09-25", "ticker": "FPT", "open": 100,
                    "high": 103, "low": 99, "close": 102, "volume": 2000,
                }]).to_excel(writer, sheet_name="PRICES", index=False)
            con = sqlite3.connect(database)
            con.execute("CREATE TABLE reports (id TEXT, title TEXT)")
            con.execute("INSERT INTO reports VALUES ('keep', 'Không thay đổi')")
            con.execute("CREATE TABLE prices (date TEXT, ticker TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL)")
            con.execute("INSERT INTO prices VALUES ('2026-09-24', 'FPT', 98, 101, 97, 100, 1500)")
            con.execute("CREATE TABLE vnindex (date TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL)")
            con.commit()
            con.close()

            with patch.object(build_db, "INPUT_DIR", input_dir), patch.object(build_db, "DB_PATH", database):
                build_db.refresh_prices()

            con = sqlite3.connect(database)
            try:
                self.assertEqual(con.execute("SELECT id, title FROM reports").fetchall(), [("keep", "Không thay đổi")])
                self.assertEqual(con.execute("SELECT ticker, close FROM prices").fetchall(), [("FPT", 102.0)])
                self.assertEqual(con.execute("SELECT close FROM vnindex").fetchall(), [(1705.0,)])
            finally:
                con.close()


if __name__ == "__main__":
    unittest.main()

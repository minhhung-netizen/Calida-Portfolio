"""
Chạy toàn bộ pipeline:  python pipeline/run.py
  --build-only   bỏ bước lấy dữ liệu (chỉ nhập inbox → DB → JSON)
  --no-prices    bỏ vnstock
  --no-gsheets   bỏ Google Sheets
Thoát mã 1 nếu bước build/export lỗi (để server/GitHub Actions nhận biết).
"""
import argparse
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_db, export_json, import_inbox  # noqa: E402


def step(name, fn, required=False):
    t = time.time()
    print(f"▶ {name}")
    try:
        fn()
        print(f"  xong ({time.time()-t:.1f}s)")
        return True
    except Exception as e:  # noqa: BLE001
        print(f"  ✖ {e}")
        if required:
            traceback.print_exc()
            sys.exit(1)
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build-only", action="store_true")
    ap.add_argument("--no-prices", action="store_true")
    ap.add_argument("--no-gsheets", action="store_true")
    a = ap.parse_args()
    if not a.build_only:
        if not a.no_gsheets:
            import fetch_gsheets
            step("Google Sheets (Portfolio, Fmarket)", fetch_gsheets.run)
        if not a.no_prices:
            import fetch_prices
            step("Giá vnstock", fetch_prices.run)
    step("Nhập báo cáo từ inbox", import_inbox.run)
    step("Build database", build_db.run, required=True)
    step("Xuất dashboard.json", export_json.run, required=True)


if __name__ == "__main__":
    main()

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
    ap.add_argument("--source", action="append", choices=("portfolio", "operations", "funds", "reports"),
                    help="Chỉ đồng bộ nguồn Google Sheets được chỉ định; có thể lặp lại tham số.")
    a = ap.parse_args()
    if a.build_only and a.source:
        ap.error("--build-only không dùng cùng --source")
    source_failures = []
    if not a.build_only:
        if not a.no_gsheets:
            import fetch_gsheets
            source_label = ", ".join(a.source) if a.source else "tất cả nguồn"
            if not step(f"Google Sheets ({source_label})", lambda: fetch_gsheets.run(a.source)):
                source_failures.append("Google Sheets")
        if not a.no_prices:
            import fetch_prices
            def fetch_prices_strict():
                failed = fetch_prices.run()
                if failed:
                    raise RuntimeError("Không lấy được giá: " + ", ".join(failed))
            if not step("Giá vnstock", fetch_prices_strict):
                source_failures.append("vnstock")
    # Báo cáo được tạo/sửa/xóa qua web là dữ liệu nguồn. Không tiếp tục dựng
    # dashboard nếu chưa ghi an toàn được các thay đổi này vào Excel.
    step("Nhập và quản lý báo cáo", import_inbox.run_all, required=True)
    step("Build database", build_db.run, required=True)
    step("Xuất dashboard.json", export_json.run, required=True)
    if source_failures:
        print("✖ Dashboard đã dựng từ dữ liệu cũ; nguồn lỗi: " + ", ".join(source_failures))
        sys.exit(2)


if __name__ == "__main__":
    main()

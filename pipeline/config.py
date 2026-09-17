"""Cấu hình pipeline. Giá trị đọc từ file .env ở thư mục gốc (nếu có) hoặc biến môi trường."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def _load_env():
    f = ROOT / ".env"
    if not f.exists():
        return
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
_load_env()

INPUT_DIR = ROOT / "data" / "input"
INBOX_DIR = ROOT / "data" / "inbox"
DB_PATH = ROOT / "data" / "calida.db"
JSON_OUT = ROOT / "web" / "data" / "dashboard.json"

# ---- Google Sheets (đọc bằng Drive API export) ----
GOOGLE_SA_FILE = os.getenv("GOOGLE_SA_FILE", "")             # đường dẫn file service account JSON
PORTFOLIO_SHEET_ID = os.getenv("PORTFOLIO_SHEET_ID", "")
FUNDS_SHEET_ID = os.getenv("FUNDS_SHEET_ID", "1CSLovnkwLaF6DHGA7Lkv4MQBIgtFJ4dMzi2M2-nWSDs")

# ---- Giá ----
PRICE_LOOKBACK_DAYS = int(os.getenv("PRICE_LOOKBACK_DAYS", "400"))
VNSTOCK_SOURCE = os.getenv("VNSTOCK_SOURCE", "VCI")

# ---- Tổng số quỹ trong vũ trụ theo dõi (để hiển thị x/y quỹ đã cập nhật). 0 = tự đếm ----
FUND_UNIVERSE_TOTAL = int(os.getenv("FUND_UNIVERSE_TOTAL", "0"))

# =====================================================================
# ÁNH XẠ CỘT GOOGLE SHEET → SCHEMA
# Bên trái: tên cột trong Google Sheet của bạn. Bên phải: tên cột chuẩn.
# CẦN CHỈNH cho khớp tiêu đề thật; fetch_gsheets.py sẽ báo lỗi kèm danh sách
# tiêu đề thực tế nếu thiếu cột.
# =====================================================================
PORTFOLIO_MAP = {
    # sheet nguồn: (file đích, sheet đích, {cột nguồn: cột chuẩn}, giá trị cố định)
    "DM cơ bản": ("portfolio.xlsx", "POSITIONS", {
        "Mã CK": "ticker", "Tên công ty": "name", "Ngành": "sector", "Trạng thái": "status",
        "Vùng mua thấp": "buy_lo", "Vùng mua cao": "buy_hi", "Target": "target",
        "Vùng vi phạm": "stop", "Giá vốn": "cost", "Ngày khuyến nghị": "rec_date",
        "Tỷ trọng": "weight_pct", "Luận điểm": "thesis",
    }, {"book": "Cơ bản"}),
    "DM lướt sóng": ("portfolio.xlsx", "POSITIONS", {
        "Mã CK": "ticker", "Tên công ty": "name", "Ngành": "sector", "Trạng thái": "status",
        "Vùng mua thấp": "buy_lo", "Vùng mua cao": "buy_hi", "Target": "target",
        "Vùng vi phạm": "stop", "Giá vốn": "cost", "Ngày khuyến nghị": "rec_date",
        "Tỷ trọng": "weight_pct", "Luận điểm": "thesis",
    }, {"book": "Lướt sóng"}),
    "Transaction Log": ("portfolio.xlsx", "TRANSACTIONS", {
        "Ngày": "date", "Mã CK": "ticker", "Hành động": "action", "Giá": "price", "Ghi chú": "note",
    }, {}),
}

FUNDS_MAP = {
    "FUND SUMMARY": ("funds.xlsx", "FUND_SUMMARY", {
        "period": "period", "fund_code": "fund_code", "fund_name": "fund_name",
        "nav_bn": "nav_bn", "ytd_pct": "ytd_pct",
    }, {}),
    "ASSET ALLOCATION": ("funds.xlsx", "ASSET_ALLOCATION", {
        "period": "period", "fund_code": "fund_code", "asset_type": "asset_type", "weight_pct": "weight_pct",
    }, {}),
    "INDUSTRY": ("funds.xlsx", "INDUSTRY", {
        "period": "period", "fund_code": "fund_code", "industry": "industry", "weight_pct": "weight_pct",
    }, {}),
    "TOP HOLDINGS": ("funds.xlsx", "TOP_HOLDINGS", {
        "period": "period", "fund_code": "fund_code", "ticker": "ticker", "weight_pct": "weight_pct",
    }, {}),
}

# Chuẩn hóa: nếu Google Sheet lưu tỷ trọng dạng 0.12 thay vì 12 → đặt True
WEIGHTS_AS_FRACTION = os.getenv("WEIGHTS_AS_FRACTION", "auto")  # auto | true | false
# Nếu NAV trong Fmarket lưu theo đồng → chia cho 1e9 để ra tỷ
NAV_DIVISOR = float(os.getenv("NAV_DIVISOR", "1"))

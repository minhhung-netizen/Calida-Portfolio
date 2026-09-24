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

DATA_DIR = Path(os.getenv("CALIDA_DATA_DIR", ROOT / "data")).resolve()
INPUT_DIR = DATA_DIR / "input"
INBOX_DIR = DATA_DIR / "inbox"
DB_PATH = DATA_DIR / "calida.db"
JSON_OUT = ROOT / "web" / "data" / "dashboard.json"

# ---- Google Sheets (đọc bằng Drive API export) ----
GOOGLE_SA_FILE = os.getenv("GOOGLE_SA_FILE", "")             # đường dẫn file service account JSON
PORTFOLIO_SHEET_ID = os.getenv("PORTFOLIO_SHEET_ID", "")
FUNDS_SHEET_ID = os.getenv("FUNDS_SHEET_ID", "")
OPERATIONS_SHEET_ID = os.getenv("OPERATIONS_SHEET_ID", "")
REPORTS_SHEET_ID = os.getenv("REPORTS_SHEET_ID", "")
# Dòng tiền có thể tạm ngưng độc lập để lỗi dữ liệu FLOW không chặn các module
# khác. Chỉ bật lại khi nguồn INVESTOR_FLOW/TICKER_FLOW/SECTOR_FLOW đã sẵn sàng.
FLOWS_MODULE_ENABLED = os.getenv("FLOWS_MODULE_ENABLED", "false").strip().lower() == "true"

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

# Google Sheet vận hành nhập tay cho các module không có nguồn tự động.
# Tiêu đề sheet/cột phải khớp file Calida_Operations_Data_Mau.xlsx.
OPERATIONS_MAP = {
    "VIEW": ("market.xlsx", "VIEW", {
        "date": "date", "sentiment": "sentiment", "support_lo": "support_lo", "support_hi": "support_hi",
        "resist_lo": "resist_lo", "resist_hi": "resist_hi", "expected_lo": "expected_lo", "expected_hi": "expected_hi",
        "today_text": "today_text", "week_text": "week_text", "focus_sectors": "focus_sectors", "risks": "risks",
        "strategy_short": "strategy_short", "strategy_long": "strategy_long", "week_actions": "week_actions",
    }, {}),
    "NEWS": ("market.xlsx", "NEWS", {"published_at": "published_at", "tab": "tab", "title": "title", "source": "source", "url": "url"}, {}),
    "EVENTS": ("market.xlsx", "EVENTS", {"date": "date", "time": "time", "name": "name", "country": "country", "impact": "impact", "forecast": "forecast", "previous": "previous"}, {}),
    "INVESTOR_FLOW": ("flows.xlsx", "INVESTOR_FLOW", {"date": "date", "investor": "investor", "net_value": "net_value"}, {}),
    "TICKER_FLOW": ("flows.xlsx", "TICKER_FLOW", {"date": "date", "ticker": "ticker", "net_value": "net_value", "main_investor": "main_investor", "note": "note"}, {}),
    "SECTOR_FLOW": ("flows.xlsx", "SECTOR_FLOW", {"date": "date", "sector": "sector", "net_value": "net_value", "chg_pct": "chg_pct", "weight_pct": "weight_pct"}, {}),
    "SUMMARY": ("portfolio.xlsx", "SUMMARY", {"date": "date", "ytd_pct": "ytd_pct", "stock_pct": "stock_pct", "cash_pct": "cash_pct", "other_pct": "other_pct"}, {}),
}

# Google Sheet Báo cáo CTCK. Giữ nguyên tiêu đề tiếng Việt của file mẫu
# Calida_Bao_Cao_CTCK_Mau.xlsx để đội phân tích nhập liệu trực tiếp.
REPORTS_MAP = {
    "BAO_CAO_CTCK": ("reports.xlsx", "REPORTS", {
        "ID": "id", "CTCK": "broker", "Ngày": "date", "Loại": "type", "Tiêu đề": "title",
        "Quan điểm": "stance", "Target VN-Index": "vn_target", "Tầm nhìn": "horizon",
        "Tóm tắt": "summary", "Nguồn": "source",
    }, {}),
    "KHUYEN_NGHI_CP": ("reports.xlsx", "REPORT_STOCKS", {
        "ID báo cáo": "report_id", "Mã cổ phiếu": "ticker", "Khuyến nghị": "rec", "Target": "target",
    }, {}),
    "QUAN_DIEM_NGANH": ("reports.xlsx", "REPORT_SECTORS", {
        "ID báo cáo": "report_id", "Ngành": "sector", "View": "view",
    }, {}),
    "RUI_RO": ("reports.xlsx", "REPORT_RISKS", {
        "ID báo cáo": "report_id", "Chủ đề rủi ro": "topic", "Mức độ": "severity",
    }, {}),
}

# Chuẩn hóa: nếu Google Sheet lưu tỷ trọng dạng 0.12 thay vì 12 → đặt True
WEIGHTS_AS_FRACTION = os.getenv("WEIGHTS_AS_FRACTION", "auto")  # auto | true | false
# Nếu NAV trong Fmarket lưu theo đồng → chia cho 1e9 để ra tỷ
NAV_DIVISOR = float(os.getenv("NAV_DIVISOR", "1"))

"""
SCHEMA — nguồn chuẩn duy nhất cho cấu trúc các file Excel đầu vào.
Mỗi file Excel = 1 nhóm dữ liệu; mỗi sheet = 1 bảng trong database (tên bảng = tên sheet viết thường).
make_templates.py tạo template từ đây; build_db.py kiểm tra cột theo đây.
"""

SCHEMA = {
    "market.xlsx": {
        "VNINDEX": {"cols": ["date", "open", "high", "low", "close", "volume"],
                    "dates": ["date"], "key": ["date"], "auto": True},
        "VIEW": {"cols": ["date", "sentiment", "support_lo", "support_hi", "resist_lo", "resist_hi",
                          "expected_lo", "expected_hi", "today_text", "week_text",
                          "focus_sectors", "risks", "strategy_short", "strategy_long", "week_actions"],
                 "dates": ["date"], "key": ["date"],
                 "note": "Mỗi ngày 1 dòng. Số dùng 1,234.56. focus_sectors, risks: phân cách dấu phẩy. week_actions: phân cách dấu |"},
        "NEWS": {"cols": ["published_at", "tab", "title", "source", "url"],
                 "dates": ["published_at"], "key": ["published_at", "title"],
                 "note": "tab: Thế giới | Trong nước | Doanh nghiệp. published_at: ngày giờ đăng"},
        "EVENTS": {"cols": ["date", "time", "name", "country", "impact", "forecast", "previous"],
                   "dates": ["date"], "key": ["date", "time", "name"],
                   "note": "impact: Cao | Trung bình | Thấp"},
    },
    "flows.xlsx": {
        "INVESTOR_FLOW": {"cols": ["date", "investor", "net_value"],
                          "dates": ["date"], "key": ["date", "investor"],
                          "note": "investor: Cá nhân | Tổ chức | Tự doanh | Khối ngoại. net_value: tỷ đồng, mua ròng dương. Số dùng 1,234.56"},
        "TICKER_FLOW": {"cols": ["date", "ticker", "net_value", "main_investor", "note"],
                        "dates": ["date"], "key": ["date", "ticker"],
                        "note": "main_investor: nhóm NĐT chi phối giao dịch ròng của mã"},
        "SECTOR_FLOW": {"cols": ["date", "sector", "net_value", "chg_pct", "weight_pct"],
                        "dates": ["date"], "key": ["date", "sector"],
                        "note": "chg_pct: % thay đổi GTGD ngành; weight_pct: tỷ trọng GTGD toàn thị trường"},
    },
    "portfolio.xlsx": {
        "POSITIONS": {"cols": ["ticker", "name", "sector", "book", "status", "buy_lo", "buy_hi",
                               "target", "stop", "cost", "rec_date", "weight_pct", "thesis"],
                      "dates": ["rec_date"], "key": ["ticker", "book"],
                      "note": "status: MUA | NẮM GIỮ | TĂNG TỶ TRỌNG | GIẢM TỶ TRỌNG | THEO DÕI. Giá: nghìn đồng, số dùng 1,234.56. weight_pct: % NAV"},
        "PRICES": {"cols": ["date", "ticker", "open", "high", "low", "close", "volume"],
                   "dates": ["date"], "key": ["date", "ticker"], "auto": True},
        "TRANSACTIONS": {"cols": ["date", "ticker", "action", "price", "note"],
                         "dates": ["date"], "key": ["date", "ticker", "action"]},
        "SUMMARY": {"cols": ["date", "ytd_pct", "stock_pct", "cash_pct", "other_pct"],
                    "dates": ["date"], "key": ["date"],
                    "note": "Tùy chọn. Nếu trống: tỷ trọng CP = tổng weight_pct, hiệu suất YTD để trống"},
    },
    "funds.xlsx": {
        "FUND_SUMMARY": {"cols": ["period", "fund_code", "fund_name", "nav_bn", "ytd_pct"],
                         "key": ["period", "fund_code"], "note": "period: MM/YYYY. nav_bn: tỷ đồng, số dùng 1,234.56"},
        "ASSET_ALLOCATION": {"cols": ["period", "fund_code", "asset_type", "weight_pct"],
                             "key": ["period", "fund_code", "asset_type"],
                             "note": "asset_type: Cổ phiếu | Tiền mặt | Trái phiếu | Khác"},
        "INDUSTRY": {"cols": ["period", "fund_code", "industry", "weight_pct"],
                     "key": ["period", "fund_code", "industry"]},
        "TOP_HOLDINGS": {"cols": ["period", "fund_code", "ticker", "weight_pct"],
                         "key": ["period", "fund_code", "ticker"]},
    },
    "reports.xlsx": {
        "REPORTS": {"cols": ["id", "broker", "date", "type", "title", "stance", "vn_target",
                             "horizon", "summary", "source"],
                    "dates": ["date"], "key": ["id"],
                    "note": "type: Chiến lược | Vĩ mô | Ngành | Doanh nghiệp. stance: Tích cực | Trung lập | Thận trọng | Tiêu cực"},
        "REPORT_STOCKS": {"cols": ["report_id", "ticker", "rec", "target"],
                          "key": ["report_id", "ticker"],
                          "note": "rec: MUA | KHẢ QUAN | TRUNG LẬP | KÉM KHẢ QUAN | BÁN. target: nghìn đồng"},
        "REPORT_SECTORS": {"cols": ["report_id", "sector", "view"],
                           "key": ["report_id", "sector"], "note": "view: OW | UW"},
        "REPORT_RISKS": {"cols": ["report_id", "topic", "severity"],
                         "key": ["report_id", "topic"], "note": "severity: 1 thấp | 2 trung bình | 3 cao"},
    },
}

INVESTORS = ["Cá nhân", "Tổ chức", "Tự doanh", "Khối ngoại"]
ACTION_STATUSES = ["MUA", "TĂNG TỶ TRỌNG", "GIẢM TỶ TRỌNG"]


def table_name(sheet: str) -> str:
    return sheet.lower()

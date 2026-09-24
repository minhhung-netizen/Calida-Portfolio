"""
Tạo file Excel đầu vào.
  python pipeline/make_templates.py            → template trống + sheet _HUONG_DAN
  python pipeline/make_templates.py --sample   → điền dữ liệu mẫu để chạy thử toàn hệ thống
Không ghi đè file đã có trừ khi thêm --force.
"""
import argparse
import random
import sys
from pathlib import Path
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import INPUT_DIR  # noqa: E402
from schema import SCHEMA, INVESTORS  # noqa: E402
from xlsx_io import write_sheets  # noqa: E402

AS_OF = pd.Timestamp("2026-09-09")


def guide(file):
    rows = []
    for sh, s in SCHEMA[file].items():
        rows.append({"sheet": sh, "cột bắt buộc": ", ".join(s["cols"]), "khóa (không trùng)": ", ".join(s["key"]),
                     "nguồn": "Tự động" if s.get("auto") else "Nhập tay / Google Sheet", "ghi chú": s.get("note", "")})
    return pd.DataFrame(rows)


def sample():
    rng = np.random.default_rng(7); random.seed(7)
    days = pd.bdate_range("2026-01-02", AS_OF)
    # VN-Index: random walk kết thúc tại 1,830.44 (phiên trước 1,821.64)
    steps = rng.normal(0.6, 12, len(days)); closes = 1830.44 - np.cumsum(steps[::-1])[::-1] + steps[-1]
    closes[-1], closes[-2] = 1830.44, 1821.64
    vn = pd.DataFrame({"date": days, "open": closes - 3, "high": closes + 6, "low": closes - 8, "close": closes.round(2),
                       "volume": rng.integers(600e6, 1100e6, len(days))})
    view = pd.DataFrame([{
        "date": AS_OF, "sentiment": "Tích cực thận trọng", "support_lo": 1800, "support_hi": 1810, "resist_lo": 1850, "resist_hi": 1870,
        "expected_lo": 1810, "expected_hi": 1870,
        "today_text": "VN-Index hồi phục lên 1,830.44 điểm nhờ lực cầu ở nhóm ngân hàng và dầu khí, nhưng thanh khoản giảm so với phiên trước. Dòng tiền phân hóa; ưu tiên chờ nhịp điều chỉnh để tích lũy ở vùng hỗ trợ.",
        "week_text": "Thị trường có thể tiếp tục dao động trong vùng 1.810 – 1.870 điểm. Xu hướng trung hạn vẫn tích cực, ưu tiên tích lũy ở các nhịp điều chỉnh. Cần theo dõi sát diễn biến từ Fed và hoạt động cơ cấu quỹ.",
        "focus_sectors": "Ngân hàng, Dầu khí, Xây dựng", "risks": "Fed, Đáo hạn phái sinh, Cơ cấu quỹ",
        "strategy_short": "Không mua đuổi; tận dụng các nhịp rung lắc để trading trên danh mục có sẵn. Ưu tiên cổ phiếu có nền tảng cơ bản tốt và thanh khoản cao.",
        "strategy_long": "Ưu tiên tích lũy từng phần trong các nhịp điều chỉnh sâu đối với doanh nghiệp có lợi thế cạnh tranh và triển vọng tăng trưởng rõ ràng.",
        "week_actions": "Không mua đuổi, hạn chế trading ngắn hạn.|Ưu tiên tích lũy khi điều chỉnh về vùng hỗ trợ.|Theo dõi nhóm ngân hàng, dầu khí, xây dựng.|Chốt lời từng phần ở cổ phiếu đạt target.",
    }])
    t = AS_OF + pd.Timedelta(hours=20)
    news = pd.DataFrame([
        [t - pd.Timedelta(hours=6), "Thế giới", "Fed phát tín hiệu có thể giữ lãi suất cao hơn lâu hơn", "Reuters", ""],
        [t - pd.Timedelta(hours=2), "Thế giới", "Giá dầu tiếp tục leo thang, vượt 99 USD/thùng", "Bloomberg", ""],
        [t - pd.Timedelta(hours=4), "Thế giới", "Dow Jones giảm 1.2% sau số liệu việc làm kém tích cực", "CNBC", ""],
        [t - pd.Timedelta(hours=8), "Trong nước", "Việt Nam thu hút thêm 1.2 tỷ USD vốn FDI trong tháng 8", "VnExpress", ""],
        [t - pd.Timedelta(hours=10), "Doanh nghiệp", "Nhiều doanh nghiệp lớn công bố kết quả kinh doanh tích cực", "CafeF", ""],
    ], columns=SCHEMA["market.xlsx"]["NEWS"]["cols"])
    events = pd.DataFrame([
        [AS_OF, "19:30", "Chỉ số giá tiêu dùng (CPI) tháng 8", "Mỹ", "Cao", "2.6%", "2.9%"],
        [AS_OF, "21:00", "Quyết định lãi suất của Fed", "Mỹ", "Cao", "4.50%", "4.50%"],
        [AS_OF + pd.Timedelta(days=1), "08:00", "GDP quý II (sơ bộ)", "Khu vực Euro", "Cao", "0.2%", "0.1%"],
        [AS_OF + pd.Timedelta(days=1), "13:00", "Sản xuất công nghiệp (IP) tháng 8", "Trung Quốc", "Trung bình", "5.8%", "5.7%"],
        [AS_OF + pd.Timedelta(days=1), "14:00", "Cán cân thương mại tháng 8", "Việt Nam", "Trung bình", "2.5 tỷ USD", "2.2 tỷ USD"],
    ], columns=SCHEMA["market.xlsx"]["EVENTS"]["cols"])

    # Dòng tiền: 4 nhóm cộng lại = 0 mỗi phiên
    inv = []
    for d in days:
        f, s, o = rng.normal(-180, 250), rng.normal(-40, 120), rng.normal(-30, 110)
        vals = dict(zip(INVESTORS, [-(f + s + o), o, s, f]))
        if d == AS_OF:
            vals = {"Cá nhân": 620, "Tổ chức": -83, "Tự doanh": -136, "Khối ngoại": -401}
        inv += [{"date": d, "investor": k, "net_value": round(v)} for k, v in vals.items()]
    tick = [("FPT", 215, "Cá nhân", ""), ("VCB", -182, "Khối ngoại", "Bán ròng mạnh"), ("HPG", 128, "Cá nhân", ""),
            ("VHM", -125, "Khối ngoại", ""), ("MBB", 92, "Cá nhân", ""), ("VRE", -98, "Khối ngoại", "Áp lực chốt lời"),
            ("VPB", 76, "Cá nhân", ""), ("SSI", -76, "Tự doanh", ""), ("TCB", 62, "Cá nhân", ""), ("VND", -64, "Tổ chức", ""),
            ("MWG", 58, "Cá nhân", ""), ("MSN", -61, "Khối ngoại", ""), ("VNM", 52, "Cá nhân", ""), ("GAS", -48, "Khối ngoại", ""),
            ("STB", 49, "Cá nhân", ""), ("BID", -44, "Khối ngoại", ""), ("HDB", 45, "Cá nhân", ""), ("PLX", -38, "Tự doanh", ""),
            ("KBC", 41, "Cá nhân", ""), ("GEX", -36, "Tổ chức", "")]
    tickf = pd.DataFrame([{"date": AS_OF, "ticker": a, "net_value": b, "main_investor": c, "note": n} for a, b, c, n in tick])
    secs = [("Ngân hàng", 320, 12.5, 18.6), ("Công nghệ thông tin", 215, 8.7, 12.5), ("Bất động sản", -210, -6.3, 11.8),
            ("Chứng khoán", -168, -5.9, 9.4), ("Thực phẩm & đồ uống", 96, 4.2, 7.1), ("Hóa chất", 74, 3.6, 6.8),
            ("Xây dựng", 62, 2.9, 5.3), ("Bán lẻ", 58, 2.7, 4.9), ("Dầu khí", -52, -2.1, 4.6), ("Điện, nước & xăng dầu khí đốt", -48, -1.9, 4.2)]
    secf = pd.DataFrame([{"date": AS_OF, "sector": a, "net_value": b, "chg_pct": c, "weight_pct": w} for a, b, c, w in secs])

    # Danh mục
    P = [("FPT", "CTCP FPT", "CNTT", "Cơ bản", "NẮM GIỮ", 118, 124, 140, 95, 112.0, "2025-07-20", 22, "Tiếp tục nắm giữ. Tích lũy thêm nếu có nhịp điều chỉnh về vùng 118 – 124.", 122.5, 121.3),
         ("MBB", "NH TMCP Quân Đội", "Ngân hàng", "Cơ bản", "MUA", 25.0, 26.2, 30, 24.9, None, "2026-09-02", 0, "Tăng trưởng tín dụng vượt ngành, CASA cải thiện.", 25.4, 25.1),
         ("HPG", "CTCP Tập đoàn Hòa Phát", "Thép", "Cơ bản", "TĂNG TỶ TRỌNG", None, None, 32, 24, 27.25, "2026-05-15", 15, "Dung Quất 2 chạy full công suất.", 28.1, 27.8),
         ("ACB", "NH TMCP Á Châu", "Ngân hàng", "Cơ bản", "GIẢM TỶ TRỌNG", None, None, 28, 23, 25.31, "2026-03-10", 14, "NIM thu hẹp, hạ tỷ trọng chờ tín hiệu mới.", 24.7, 24.5),
         ("DGC", "CTCP Tập đoàn Hóa chất Đức Giang", "Hóa chất", "Cơ bản", "NẮM GIỮ", 88, 92, 110, 82, 87.35, "2026-04-12", 12, "Dự án Nghi Sơn là động lực trung hạn.", 93.2, 92.4),
         ("CTD", "CTCP Xây dựng Coteccons", "Xây dựng", "Cơ bản", "MUA", 64, 68, 80, 60, None, "2026-09-05", 0, "Backlog kỷ lục, biên gộp phục hồi.", 67.5, 66.9),
         ("VCI", "CTCP Chứng khoán Vietcap", "Chứng khoán", "Lướt sóng", "NẮM GIỮ", 38, 42, 50, 41.5, 42.1, "2026-06-01", 10, "Hưởng lợi nâng hạng thị trường.", 41.3, 40.9),
         ("KBC", "TCT Phát triển Đô thị Kinh Bắc", "BĐS", "Lướt sóng", "THEO DÕI", 28, 30, 36, 26, None, "2026-08-28", 0, "Chờ ghi nhận bàn giao KCN.", 29.8, 29.5)]
    cols = SCHEMA["portfolio.xlsx"]["POSITIONS"]["cols"]
    pos = pd.DataFrame([dict(zip(cols, p[:13])) for p in P])
    prices = []
    for p in P:
        t, close, low = p[0], p[13], p[14]
        path = close * np.exp(np.cumsum(rng.normal(0, 0.012, 60))[::-1] - np.cumsum(rng.normal(0, 0.012, 60))[::-1][-1])
        for d, c in zip(days[-60:], path):
            prices.append({"date": d, "ticker": t, "open": c, "high": c * 1.01, "low": c * 0.99, "close": round(c, 2), "volume": 1e6})
        prices[-1].update(close=close, low=low, high=close * 1.01, open=close)
        prices[-2].update(close=round(close - {"FPT": 1.2, "ACB": -0.2, "VCI": -0.4}.get(t, 0.3), 2))
    tx = pd.DataFrame([
        ["2026-09-05", "CTD", "Khuyến nghị mua", "64 – 68", "Mở vị thế mới"],
        ["2026-09-02", "MBB", "Khuyến nghị mua", "25.0 – 26.2", "Mở vị thế mới"],
        ["2026-08-28", "ACB", "Giảm tỷ trọng 50%", "25.10", "Lần 1 trong chu kỳ"],
        ["2026-08-20", "HPG", "Gia tăng tỷ trọng", "27.60", "Giá vốn BQ về 27.25"],
        ["2026-08-14", "PNJ", "Bán hết", "98.40", "Đóng vị thế +14.2%"]], columns=SCHEMA["portfolio.xlsx"]["TRANSACTIONS"]["cols"])
    summ = pd.DataFrame([{"date": AS_OF, "ytd_pct": 2.3, "stock_pct": 85, "cash_pct": 10, "other_pct": 5}])

    # Quỹ: 2 kỳ, 14 quỹ
    codes = ["VFM", "VCBF", "SSIAM", "TCBS", "MBBAM", "KIM", "DCVFM", "VND", "BVF", "PVI", "MAFM", "VINACAPITAL", "UVEEF", "LHC"]
    inds = ["Chứng khoán", "Xây dựng", "Hóa chất", "Ngân hàng", "Bất động sản", "Điện, nước & xăng dầu khí đốt", "Thực phẩm & đồ uống", "Công nghệ thông tin", "Thép", "Bán lẻ"]
    stocks = ["CTD", "VCI", "VND", "HPG", "FPT", "MBB", "DGC", "ACB", "MWG", "VHM", "GAS", "SSI", "TCB", "REE"]
    fsum, aa, ind, th = [], [], [], []
    base_nav = dict(zip(codes, [7900, 7050, 5900, 5100, 4700, 3600, 3100, 2600, 1800, 1300, 1100, 900, 700, 500]))
    for pi, per in enumerate(["07/2026", "08/2026"]):
        for c in codes:
            if per == "08/2026" and c in ("UVEEF", "LHC"):
                continue  # chưa cập nhật kỳ này
            nav = base_nav[c] * (1 + 0.023 * pi + rng.normal(0, 0.01))
            fsum.append({"period": per, "fund_code": c, "fund_name": f"Quỹ {c}", "nav_bn": round(nav), "ytd_pct": round(rng.uniform(5, 13), 1)})
            sw = rng.uniform(84, 91) + pi * rng.normal(0.8, 0.6)
            aa += [{"period": per, "fund_code": c, "asset_type": "Cổ phiếu", "weight_pct": round(sw, 2)},
                   {"period": per, "fund_code": c, "asset_type": "Tiền mặt", "weight_pct": round(100 - sw - 1.5, 2)},
                   {"period": per, "fund_code": c, "asset_type": "Khác", "weight_pct": 1.5}]
            w = rng.dirichlet(np.ones(len(inds)) * 3) * sw
            tilt = {"Chứng khoán": 0.6, "Hóa chất": 0.9, "Bất động sản": -0.7, "Điện, nước & xăng dầu khí đốt": 1.2, "Thực phẩm & đồ uống": -0.5}
            ind += [{"period": per, "fund_code": c, "industry": k, "weight_pct": round(max(0, v + pi * tilt.get(k, 0)), 2)} for k, v in zip(inds, w)]
            hw = sorted(rng.uniform(2, 6, 10), reverse=True)
            th += [{"period": per, "fund_code": c, "ticker": s, "weight_pct": round(v, 2)} for s, v in zip(rng.permutation(stocks)[:10], hw)]

    # Báo cáo CTCK (mẫu minh họa)
    R = [
        ("R01", "SSI Research", "2026-09-08", "Chiến lược", "Chiến lược tháng 9: Tích lũy chọn lọc", "Tích cực", 1950, "Cuối 2026", ["Ngân hàng", "Chứng khoán", "Bán lẻ"], ["Bất động sản"], [("MBB", "MUA", 31), ("MWG", "MUA", 78)], [("Fed/lãi suất USD", 2), ("Tỷ giá", 2)], "Duy trì quan điểm tích cực nhờ lợi nhuận quý III dự báo tăng 16%; khuyến nghị giải ngân từng phần khi VN-Index về 1.800."),
        ("R02", "Vietcap", "2026-09-07", "Chiến lược", "Triển vọng quý IV/2026", "Tích cực", 1980, "12 tháng", ["Ngân hàng", "Công nghệ thông tin", "Xây dựng"], ["Điện, nước & xăng dầu khí đốt"], [("FPT", "MUA", 142), ("CTD", "MUA", 82), ("ACB", "KHẢ QUAN", 28)], [("Nâng hạng FTSE", 1), ("Định giá", 2)], "P/E dự phóng 12.4x vẫn thấp hơn trung bình 5 năm; nâng hạng là chất xúc tác chính nửa sau năm."),
        ("R03", "HSC", "2026-09-06", "Vĩ mô", "Vĩ mô tháng 8: Áp lực tỷ giá quay lại", "Trung lập", 1880, "Cuối 2026", ["Xuất khẩu", "Công nghệ thông tin"], ["Bất động sản", "Chứng khoán"], [], [("Tỷ giá", 3), ("Lạm phát/giá dầu", 2), ("Fed/lãi suất USD", 3)], "USD/VND tăng 3.1% YTD; NHNN có thể hút ròng qua tín phiếu, gây áp lực lên lãi suất liên ngân hàng."),
        ("R04", "VNDirect", "2026-09-05", "Ngành", "Ngành ngân hàng: Chu kỳ tín dụng mới", "Tích cực", None, "12 tháng", ["Ngân hàng"], [], [("MBB", "MUA", 30.5), ("VCB", "KHẢ QUAN", 102), ("ACB", "TRUNG LẬP", 26.5)], [("Chất lượng tài sản", 2), ("Tăng trưởng tín dụng", 1)], "Tín dụng tăng 11.2% YTD; nợ xấu nhóm tư nhân đã qua đỉnh. Ưu tiên ngân hàng có CASA cao."),
        ("R05", "MBS Research", "2026-09-05", "Chiến lược", "Nhận định tuần 37", "Trung lập", 1900, "Cuối 2026", ["Ngân hàng", "Dầu khí", "Xây dựng"], ["Bất động sản"], [("HPG", "MUA", 33), ("DGC", "MUA", 112)], [("Đáo hạn phái sinh/cơ cấu quỹ", 2), ("Fed/lãi suất USD", 2), ("Khối ngoại bán ròng", 2)], "Thị trường tích lũy trong biên 1.810–1.870; cơ cấu danh mục ETF quý III có thể gây biến động ngắn hạn."),
        ("R06", "KBSV", "2026-09-04", "Chiến lược", "Góc nhìn thị trường tháng 9", "Thận trọng", 1760, "3 tháng", ["Tiện ích"], ["Chứng khoán", "Bất động sản", "Thép"], [("HPG", "TRUNG LẬP", 29)], [("Định giá", 3), ("Khối ngoại bán ròng", 3), ("Margin cao", 3)], "Dư nợ margin toàn thị trường lập đỉnh mới; rủi ro điều chỉnh về vùng 1.720–1.760 nếu thanh khoản suy yếu."),
        ("R07", "BSC", "2026-09-03", "Doanh nghiệp", "FPT – Cập nhật KQKD 7T2026", "Tích cực", None, "12 tháng", ["Công nghệ thông tin"], [], [("FPT", "MUA", 138)], [("Thuế quan/thương mại", 1)], "Doanh thu CNTT nước ngoài tăng 28%; backlog Nhật Bản hỗ trợ tăng trưởng 2027."),
        ("R08", "ACBS", "2026-09-02", "Ngành", "Ngành xây dựng: Đầu tư công tăng tốc", "Tích cực", None, "12 tháng", ["Xây dựng", "Vật liệu xây dựng"], [], [("CTD", "MUA", 79), ("HPG", "MUA", 34)], [("Giải ngân đầu tư công chậm", 2)], "Giải ngân đầu tư công 8T đạt 47% kế hoạch, cao nhất 5 năm; nhà thầu có backlog lớn hưởng lợi."),
        ("R09", "Mirae Asset", "2026-08-30", "Chiến lược", "Chiến lược nửa cuối 2026", "Trung lập", 1890, "Cuối 2026", ["Ngân hàng", "Hóa chất"], ["Bán lẻ"], [("DGC", "MUA", 108)], [("Thuế quan/thương mại", 2), ("Tỷ giá", 2)], "Tăng trưởng EPS 2026 ước 14%; rủi ro thương mại với Mỹ vẫn là biến số chính."),
        ("R10", "SSI Research", "2026-08-28", "Ngành", "Ngành chứng khoán: Nâng hạng và margin", "Trung lập", None, "12 tháng", ["Chứng khoán"], [], [("VCI", "KHẢ QUAN", 47), ("SSI", "TRUNG LẬP", 36)], [("Margin cao", 2), ("Nâng hạng FTSE", 1)], "Định giá P/B đã phản ánh phần lớn kỳ vọng nâng hạng; chọn lọc công ty có mảng IB mạnh."),
        ("R11", "HSC", "2026-08-27", "Doanh nghiệp", "KBC – Chờ đợi bàn giao", "Trung lập", None, "12 tháng", [], ["Bất động sản"], [("KBC", "TRUNG LẬP", 32)], [("Pháp lý BĐS", 2)], "Tiến độ bàn giao KCN Tràng Duệ 3 chậm hơn kỳ vọng; lợi nhuận dồn vào quý IV."),
        ("R12", "VNDirect", "2026-08-25", "Vĩ mô", "Lạm phát và giá dầu", "Thận trọng", 1840, "3 tháng", ["Dầu khí"], ["Bán lẻ", "Hàng không"], [], [("Lạm phát/giá dầu", 3), ("Fed/lãi suất USD", 2)], "Giá dầu trên 95 USD làm CPI có thể vượt 4%; dư địa nới lỏng tiền tệ thu hẹp."),
    ]
    reps = pd.DataFrame([{"id": r[0], "broker": r[1], "date": r[2], "type": r[3], "title": r[4], "stance": r[5], "vn_target": r[6],
                          "horizon": r[7], "summary": r[12], "source": "Dữ liệu mẫu"} for r in R])
    rs = pd.DataFrame([{"report_id": r[0], "ticker": t, "rec": c, "target": g} for r in R for t, c, g in r[10]])
    rsec = pd.DataFrame([{"report_id": r[0], "sector": s, "view": "OW"} for r in R for s in r[8]] +
                        [{"report_id": r[0], "sector": s, "view": "UW"} for r in R for s in r[9]])
    rr = pd.DataFrame([{"report_id": r[0], "topic": k, "severity": s} for r in R for k, s in r[11]])

    return {
        "market.xlsx": {"VNINDEX": vn, "VIEW": view, "NEWS": news, "EVENTS": events},
        "flows.xlsx": {"INVESTOR_FLOW": pd.DataFrame(inv), "TICKER_FLOW": tickf, "SECTOR_FLOW": secf},
        "portfolio.xlsx": {"POSITIONS": pos, "PRICES": pd.DataFrame(prices), "TRANSACTIONS": tx, "SUMMARY": summ},
        "funds.xlsx": {"FUND_SUMMARY": pd.DataFrame(fsum), "ASSET_ALLOCATION": pd.DataFrame(aa), "INDUSTRY": pd.DataFrame(ind), "TOP_HOLDINGS": pd.DataFrame(th)},
        "reports.xlsx": {"REPORTS": reps, "REPORT_STOCKS": rs, "REPORT_SECTORS": rsec, "REPORT_RISKS": rr},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", action="store_true")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    data = sample() if a.sample else {}
    INPUT_DIR.mkdir(parents=True, exist_ok=True)
    for file in SCHEMA:
        path = INPUT_DIR / file
        if path.exists() and not a.force:
            print(f"  giữ nguyên {file} (dùng --force để ghi đè)"); continue
        if path.exists():
            path.unlink()
        frames = {sh: data.get(file, {}).get(sh, pd.DataFrame(columns=s["cols"])) for sh, s in SCHEMA[file].items()}
        frames["_HUONG_DAN"] = guide(file)
        write_sheets(file, frames)
        print(f"  tạo {file}")


if __name__ == "__main__":
    main()

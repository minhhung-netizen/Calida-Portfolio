"""
Tải Google Sheet (Portfolio Automation, Fmarket DB) qua Drive API export → chuẩn hóa cột → Excel đầu vào.
Cần: service account có quyền Viewer trên 2 sheet (share email của service account vào sheet).
"""
import io
import pandas as pd
from config import (GOOGLE_SA_FILE, PORTFOLIO_SHEET_ID, FUNDS_SHEET_ID, OPERATIONS_SHEET_ID, REPORTS_SHEET_ID, PORTFOLIO_MAP, FUNDS_MAP, OPERATIONS_MAP, REPORTS_MAP,
                    WEIGHTS_AS_FRACTION, NAV_DIVISOR)
from schema import SCHEMA
from xlsx_io import write_sheets, upsert
from number_normalizer import normalize_numeric_columns, parse_number_series

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# Ba nguồn dưới đây là ảnh chụp hoàn chỉnh của dữ liệu nghiệp vụ. Mỗi lần đồng
# bộ sẽ thay thế đúng các sheet mà nguồn đó quản lý, để một dòng đã bị xóa hoặc
# sửa trên Google Sheets không tiếp tục nằm lại trong Railway Volume. Riêng báo
# cáo CTCK được gộp theo khóa nhằm bảo toàn các báo cáo tạo trực tiếp trên web.
SOURCE_DEFINITIONS = {
    "portfolio": {
        "label": "Danh mục", "sheet_id": PORTFOLIO_SHEET_ID,
        "mapping": PORTFOLIO_MAP, "snapshot": True,
    },
    "operations": {
        "label": "Vận hành", "sheet_id": OPERATIONS_SHEET_ID,
        "mapping": OPERATIONS_MAP, "snapshot": True,
    },
    "funds": {
        "label": "Quỹ", "sheet_id": FUNDS_SHEET_ID,
        "mapping": FUNDS_MAP, "snapshot": True,
    },
    "reports": {
        "label": "Báo cáo CTCK", "sheet_id": REPORTS_SHEET_ID,
        "mapping": REPORTS_MAP, "snapshot": False,
    },
}


def supported_sources():
    """Danh sách nguồn hợp lệ dùng cho CLI và API quản trị."""
    return tuple(SOURCE_DEFINITIONS)


def download(sheet_id: str) -> dict:
    from google.oauth2 import service_account
    from google.auth.transport.requests import AuthorizedSession
    if not GOOGLE_SA_FILE:
        raise RuntimeError("Chưa đặt GOOGLE_SA_FILE trong .env")
    creds = service_account.Credentials.from_service_account_file(
        GOOGLE_SA_FILE, scopes=["https://www.googleapis.com/auth/drive.readonly"])
    sess = AuthorizedSession(creds)
    r = sess.get(f"https://www.googleapis.com/drive/v3/files/{sheet_id}/export",
                 params={"mimeType": XLSX_MIME}, timeout=120)
    if r.status_code != 200:
        raise RuntimeError(f"Drive export lỗi {r.status_code}: {r.text[:300]}")
    return pd.read_excel(io.BytesIO(r.content), sheet_name=None)


def _find_header(df: pd.DataFrame, wanted: set) -> pd.DataFrame:
    """Sheet có thể có dòng tiêu đề không nằm ở dòng 1 → dò 15 dòng đầu."""
    cols = {str(c).strip() for c in df.columns}
    if wanted & cols:
        df.columns = [str(c).strip() for c in df.columns]
        return df
    for i in range(min(15, len(df))):
        row = [str(v).strip() for v in df.iloc[i].tolist()]
        if len(wanted & set(row)) >= max(2, len(wanted) // 2):
            out = df.iloc[i + 1:].copy()
            out.columns = row
            return out
    df.columns = [str(c).strip() for c in df.columns]
    return df


def _pct(series: pd.Series) -> pd.Series:
    s = parse_number_series(series)
    frac = WEIGHTS_AS_FRACTION.lower()
    if frac == "true" or (frac == "auto" and s.dropna().abs().max() <= 1.0 and len(s.dropna())):
        s = s * 100
    return s


def apply_map(book: dict, mapping: dict) -> dict:
    out = {}
    for src, (file, dst, colmap, const) in mapping.items():
        if src not in book:
            raise RuntimeError(f"Không thấy sheet '{src}'. Sheet hiện có: {list(book)}")
        df = _find_header(book[src], set(colmap))
        missing = [c for c in colmap if c not in df.columns]
        if missing:
            raise RuntimeError(f"Sheet '{src}' thiếu cột {missing}.\n  Tiêu đề thực tế: {list(df.columns)}\n"
                               f"  → Sửa PORTFOLIO_MAP/FUNDS_MAP trong pipeline/config.py")
        df = df[list(colmap)].rename(columns=colmap)
        for k, v in const.items():
            df[k] = v
        first = list(colmap.values())[0]
        df = df[df[first].notna() & (df[first].astype(str).str.strip() != "")]
        df = normalize_numeric_columns(df)
        for c in df.columns:
            if c.endswith("_pct"):
                df[c] = _pct(df[c])
        if "nav_bn" in df:
            df["nav_bn"] = parse_number_series(df["nav_bn"]) / NAV_DIVISOR
        if "ticker" in df:
            df["ticker"] = df["ticker"].astype(str).str.strip().str.upper()
        if "status" in df:
            df["status"] = df["status"].astype(str).str.strip().str.upper()
        if "period" in df:
            df["period"] = df["period"].map(_period)
        out.setdefault((file, dst), []).append(df)
    return {k: pd.concat(v, ignore_index=True) for k, v in out.items()}


def write_snapshot(frames: dict):
    """Thay thế các sheet được một nguồn Google Sheets quản lý.

    ``write_sheets`` vẫn giữ nguyên sheet thuộc nguồn khác trong cùng workbook,
    ví dụ SUMMARY của Operations khi chỉ đồng bộ Danh mục.
    """
    grouped = {}
    for (file, sheet), frame in frames.items():
        grouped.setdefault(file, {})[sheet] = frame.reindex(columns=SCHEMA[file][sheet]["cols"])
    for file, sheets in grouped.items():
        write_sheets(file, sheets)
        for sheet, frame in sheets.items():
            print(f"    {sheet}: {len(frame)} dòng (thay thế bản cũ)")


def merge_by_key(frames: dict):
    """Cập nhật theo khóa, dùng cho báo cáo tạo được cả trên web lẫn Sheets."""
    for (file, sheet), frame in frames.items():
        print(f"    {sheet}: {upsert(file, sheet, frame)} dòng (gộp theo khóa)")


def _period(v):
    """Chuẩn hóa kỳ về MM/YYYY (nhận 2026-08, 08/2026, datetime…)."""
    if pd.isna(v):
        return v
    if hasattr(v, "month"):
        return f"{v.month:02d}/{v.year}"
    s = str(v).strip()
    for fmt in ("%m/%Y", "%Y-%m", "%Y-%m-%d", "%d/%m/%Y", "%Y%m"):
        try:
            d = pd.to_datetime(s, format=fmt)
            return f"{d.month:02d}/{d.year}"
        except (ValueError, TypeError):
            continue
    return s


def run(sources=None):
    """Đồng bộ toàn bộ hoặc một nguồn Google Sheets đã chọn.

    ``sources`` nhận portfolio, operations, funds hoặc reports. Bỏ trống để
    đồng bộ tất cả; tên nguồn sai phải dừng ngay thay vì vô tình chạy full sync.
    """
    selected = tuple(sources or supported_sources())
    unknown = sorted(set(selected) - set(SOURCE_DEFINITIONS))
    if unknown:
        raise ValueError(f"Nguồn Google Sheets không hợp lệ: {', '.join(unknown)}")
    for source in selected:
        definition = SOURCE_DEFINITIONS[source]
        sheet_id = definition["sheet_id"]
        if not sheet_id:
            print(f"  Bỏ qua {definition['label']} (chưa đặt biến ID tương ứng)")
            continue
        mode = "bản chụp" if definition["snapshot"] else "gộp theo khóa"
        print(f"  {definition['label']} ({mode})…")
        frames = apply_map(download(sheet_id), definition["mapping"])
        if definition["snapshot"]:
            write_snapshot(frames)
        else:
            merge_by_key(frames)


if __name__ == "__main__":
    run()

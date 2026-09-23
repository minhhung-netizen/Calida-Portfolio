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

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


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
    s = pd.to_numeric(series, errors="coerce")
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
        for c in df.columns:
            if c.endswith("_pct"):
                df[c] = _pct(df[c])
        if "nav_bn" in df:
            df["nav_bn"] = pd.to_numeric(df["nav_bn"], errors="coerce") / NAV_DIVISOR
        if "ticker" in df:
            df["ticker"] = df["ticker"].astype(str).str.strip().str.upper()
        if "status" in df:
            df["status"] = df["status"].astype(str).str.strip().str.upper()
        if "period" in df:
            df["period"] = df["period"].map(_period)
        out.setdefault((file, dst), []).append(df)
    return {k: pd.concat(v, ignore_index=True) for k, v in out.items()}


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


def run():
    if PORTFOLIO_SHEET_ID:
        print("  Portfolio sheet…")
        for (file, dst), df in apply_map(download(PORTFOLIO_SHEET_ID), PORTFOLIO_MAP).items():
            if dst == "POSITIONS":  # danh mục hiện tại = ảnh chụp mới nhất → ghi đè
                write_sheets(file, {dst: df.reindex(columns=SCHEMA[file][dst]["cols"])})
                print(f"    {dst}: {len(df)} dòng")
            else:
                print(f"    {dst}: {upsert(file, dst, df)} dòng")
    else:
        print("  Bỏ qua Portfolio (chưa đặt PORTFOLIO_SHEET_ID)")
    if FUNDS_SHEET_ID:
        print("  Fmarket DB…")
        for (file, dst), df in apply_map(download(FUNDS_SHEET_ID), FUNDS_MAP).items():
            print(f"    {dst}: {upsert(file, dst, df)} dòng")
    else:
        print("  Bỏ qua Fmarket DB (chưa đặt FUNDS_SHEET_ID)")
    if OPERATIONS_SHEET_ID:
        print("  Operations Data…")
        for (file, dst), df in apply_map(download(OPERATIONS_SHEET_ID), OPERATIONS_MAP).items():
            print(f"    {dst}: {upsert(file, dst, df)} dòng")
    else:
        print("  Bỏ qua Operations Data (chưa đặt OPERATIONS_SHEET_ID)")
    if REPORTS_SHEET_ID:
        print("  Báo cáo CTCK…")
        for (file, dst), df in apply_map(download(REPORTS_SHEET_ID), REPORTS_MAP).items():
            print(f"    {dst}: {upsert(file, dst, df)} dòng")
    else:
        print("  Bỏ qua Báo cáo CTCK (chưa đặt REPORTS_SHEET_ID)")


if __name__ == "__main__":
    run()

"""Gộp toàn bộ Excel đầu vào → SQLite (data/calida.db). Kiểm tra cột theo SCHEMA."""
import sqlite3
import shutil
from datetime import datetime
import pandas as pd
from config import DB_PATH, INPUT_DIR, FLOWS_MODULE_ENABLED
from data_quality import raise_for_errors, validate
from data_admin import apply_tombstones
from schema import SCHEMA, table_name


def to_date(s: pd.Series) -> pd.Series:
    """Nhận datetime Excel, ISO (2026-09-09) và kiểu Việt Nam (09/09/2026)."""
    out = pd.to_datetime(s, errors="coerce", format="ISO8601")
    rest = out.isna() & s.notna()
    if rest.any():
        out[rest] = pd.to_datetime(s[rest].astype(str), errors="coerce", dayfirst=True, format="mixed")
    return out


def run() -> list:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    warnings, stats, frames = [], [], {}
    tmp = DB_PATH.with_suffix(".tmp.db")
    if tmp.exists():
        tmp.unlink()
    for file, sheets in SCHEMA.items():
        path = INPUT_DIR / file
        book = pd.read_excel(path, sheet_name=None) if path.exists() else {}
        if not path.exists():
            warnings.append(f"Thiếu file {file}")
        for sh, s in sheets.items():
            df = book.get(sh, pd.DataFrame(columns=s["cols"]))
            df.columns = [str(c).strip() for c in df.columns]
            missing = [c for c in s["cols"] if c not in df.columns]
            if missing:
                warnings.append(f"{file}/{sh} thiếu cột {missing} → để trống")
            df = df.reindex(columns=s["cols"]).dropna(how="all")
            for c in s.get("dates", []):
                df[c] = to_date(df[c])
                bad = df[c].isna().sum()
                if bad:
                    warnings.append(f"{file}/{sh}: {bad} dòng sai định dạng ngày ở cột {c} → bỏ")
                    df = df[df[c].notna()]
                df[c] = df[c].dt.strftime("%Y-%m-%d %H:%M:%S" if c == "published_at" else "%Y-%m-%d")
            dup = df.duplicated(subset=s["key"], keep="last").sum()
            if dup:
                warnings.append(f"{file}/{sh}: {dup} dòng trùng khóa {s['key']} → giữ dòng cuối")
                df = df.drop_duplicates(subset=s["key"], keep="last")
            frames[(file, sh)] = df

    deleted = apply_tombstones(frames)
    if deleted:
        print(f"  Đã loại {deleted} dòng theo lịch sử xoá của quản trị viên")

    if not FLOWS_MODULE_ENABLED:
        # Giữ nguyên workbook để có thể mở lại sau này, nhưng không đưa dữ liệu
        # Dòng tiền cũ/dở dang vào DB hoặc kiểm tra chất lượng của lần chạy này.
        for sheet in ("INVESTOR_FLOW", "TICKER_FLOW", "SECTOR_FLOW"):
            frames[("flows.xlsx", sheet)] = pd.DataFrame(columns=SCHEMA["flows.xlsx"][sheet]["cols"])
        print("  ⏸ Dòng tiền đang tạm dừng — bỏ qua dữ liệu FLOW trong lần dựng này")

    quality = validate(frames)
    for issue in quality:
        icon = "✖" if issue["level"] == "error" else "⚠"
        print(f"  {icon} {issue['scope']}: {issue['message']} ({issue['count']} dòng)")
    raise_for_errors(quality)

    con = sqlite3.connect(tmp)
    for file, sheets in SCHEMA.items():
        for sh in sheets:
            df = frames[(file, sh)]
            df.to_sql(table_name(sh), con, index=False)
            stats.append((table_name(sh), len(df)))
    pd.DataFrame(stats, columns=["table", "rows"]).assign(built_at=datetime.now().isoformat(timespec="seconds")) \
        .to_sql("_meta", con, index=False)
    pd.DataFrame(quality, columns=["id", "level", "scope", "message", "count"]).to_sql("_quality", con, index=False)
    con.close()
    tmp.replace(DB_PATH)  # thay file DB một lần, server không đọc phải file dở dang
    for t, n in stats:
        print(f"  {t:<18} {n:>7} dòng")
    for w in warnings:
        print(f"  ⚠ {w}")
    return warnings + [f"{item['scope']}: {item['message']}" for item in quality if item["level"] == "warning"]


def refresh_prices() -> list:
    """Chỉ thay bảng VN-Index/giá trong DB, không kiểm tra lại các module khác."""
    if not DB_PATH.exists():
        return run()
    frames, stats = {}, []
    for file, sheet in (("market.xlsx", "VNINDEX"), ("portfolio.xlsx", "PRICES")):
        spec = SCHEMA[file][sheet]
        path = INPUT_DIR / file
        if not path.exists():
            raise FileNotFoundError(f"Thiếu file {file}")
        df = pd.read_excel(path, sheet_name=sheet)
        df.columns = [str(c).strip() for c in df.columns]
        missing = [column for column in spec["cols"] if column not in df.columns]
        if missing:
            raise ValueError(f"{file}/{sheet} thiếu cột {missing}")
        df = df.reindex(columns=spec["cols"]).dropna(how="all")
        for column in spec.get("dates", []):
            parsed = to_date(df[column])
            if parsed.isna().any():
                raise ValueError(f"{file}/{sheet}: {int(parsed.isna().sum())} dòng sai định dạng ngày ở cột {column}")
            df[column] = parsed.dt.strftime("%Y-%m-%d")
        df = df.drop_duplicates(subset=spec["key"], keep="last")
        frames[(file, sheet)] = df

    quality = validate(frames)
    for issue in quality:
        icon = "✖" if issue["level"] == "error" else "⚠"
        print(f"  {icon} {issue['scope']}: {issue['message']} ({issue['count']} dòng)")
    raise_for_errors(quality)

    tmp = DB_PATH.with_suffix(".prices.tmp.db")
    if tmp.exists():
        tmp.unlink()
    shutil.copy2(DB_PATH, tmp)
    try:
        con = sqlite3.connect(tmp)
        try:
            for (file, sheet), df in frames.items():
                table = table_name(sheet)
                df.to_sql(table, con, index=False, if_exists="replace")
                stats.append((table, len(df)))
            con.commit()
        finally:
            con.close()
        tmp.replace(DB_PATH)
    finally:
        if tmp.exists():
            tmp.unlink()
    for table, rows in stats:
        print(f"  {table:<18} {rows:>7} dòng")
    return [f"{item['scope']}: {item['message']}" for item in quality if item["level"] == "warning"]


if __name__ == "__main__":
    run()

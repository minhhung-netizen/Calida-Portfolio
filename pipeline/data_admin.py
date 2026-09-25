"""Quản trị dữ liệu theo module/ngày và giữ dấu xoá qua các lần đồng bộ."""
import argparse
import json
import sys
from datetime import date, datetime
from pathlib import Path
from uuid import uuid4

import pandas as pd

from config import DATA_DIR
from schema import SCHEMA
from xlsx_io import read_sheet, write_sheets


DELETE_STORE = DATA_DIR / "data-deletions.json"
MODULES = {
    "brief": {
        "label": "Bản tin",
        "tables": (("market.xlsx", "VIEW", "date"), ("market.xlsx", "NEWS", "published_at"), ("market.xlsx", "EVENTS", "date")),
    },
    "portfolio": {
        "label": "Danh mục",
        "tables": (("portfolio.xlsx", "POSITIONS", "rec_date"), ("portfolio.xlsx", "PRICES", "date"), ("portfolio.xlsx", "TRANSACTIONS", "date"), ("portfolio.xlsx", "SUMMARY", "date")),
    },
    "flows": {
        "label": "Dòng tiền",
        "tables": (("flows.xlsx", "INVESTOR_FLOW", "date"), ("flows.xlsx", "TICKER_FLOW", "date"), ("flows.xlsx", "SECTOR_FLOW", "date")),
    },
    "funds": {
        "label": "Quỹ đầu tư",
        "tables": (("funds.xlsx", "FUND_SUMMARY", "period"), ("funds.xlsx", "ASSET_ALLOCATION", "period"), ("funds.xlsx", "INDUSTRY", "period"), ("funds.xlsx", "TOP_HOLDINGS", "period")),
    },
    "reports": {
        "label": "Báo cáo CTCK",
        "tables": (("reports.xlsx", "REPORTS", "date"), ("reports.xlsx", "REPORT_STOCKS", None), ("reports.xlsx", "REPORT_SECTORS", None), ("reports.xlsx", "REPORT_RISKS", None)),
    },
}
TABLE_LABELS = {
    "VIEW": "Nhận định thị trường", "NEWS": "Tin tức", "EVENTS": "Sự kiện",
    "POSITIONS": "Vị thế danh mục", "PRICES": "Giá", "TRANSACTIONS": "Giao dịch", "SUMMARY": "Tổng quan danh mục",
    "INVESTOR_FLOW": "Dòng tiền nhà đầu tư", "TICKER_FLOW": "Dòng tiền cổ phiếu", "SECTOR_FLOW": "Dòng tiền ngành",
    "FUND_SUMMARY": "Tổng quan quỹ", "ASSET_ALLOCATION": "Phân bổ tài sản", "INDUSTRY": "Phân bổ ngành", "TOP_HOLDINGS": "Khoản nắm giữ lớn",
    "REPORTS": "Báo cáo", "REPORT_STOCKS": "Khuyến nghị cổ phiếu", "REPORT_SECTORS": "Quan điểm ngành", "REPORT_RISKS": "Rủi ro",
}


def _empty_store():
    return {"version": 1, "tables": {}, "history": []}


def load_store():
    try:
        value = json.loads(DELETE_STORE.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or not isinstance(value.get("tables"), dict):
            raise ValueError("invalid deletion store")
        value.setdefault("version", 1)
        value.setdefault("history", [])
        return value
    except FileNotFoundError:
        return _empty_store()


def save_store(value):
    DELETE_STORE.parent.mkdir(parents=True, exist_ok=True)
    temp = DELETE_STORE.with_name(f".{DELETE_STORE.stem}-{uuid4().hex}.tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(DELETE_STORE)


def _table_id(file, sheet):
    return f"{file}/{sheet}"


def _key_value(value, is_date=False):
    if pd.isna(value):
        return ""
    if is_date:
        parsed = pd.to_datetime(value, errors="coerce", format="ISO8601")
        if pd.isna(parsed):
            parsed = pd.to_datetime(str(value), errors="coerce", dayfirst=True, format="mixed")
        if not pd.isna(parsed):
            return parsed.strftime("%Y-%m-%d %H:%M:%S" if getattr(parsed, "hour", 0) or getattr(parsed, "minute", 0) or getattr(parsed, "second", 0) else "%Y-%m-%d")
    if isinstance(value, (datetime, date, pd.Timestamp)):
        return pd.Timestamp(value).isoformat()
    return str(value).strip()


def _row_key(file, sheet, row):
    spec = SCHEMA[file][sheet]
    date_columns = set(spec.get("dates", []))
    return [_key_value(row.get(column), column in date_columns) for column in spec["key"]]


def apply_tombstones(frames, store=None):
    """Loại các khóa đã xoá khỏi frames; dùng cả khi build lại sau đồng bộ."""
    store = store or load_store()
    removed = 0
    for (file, sheet), frame in list(frames.items()):
        saved = store.get("tables", {}).get(_table_id(file, sheet), [])
        if frame.empty or not saved:
            continue
        deleted = {tuple(map(str, key)) for key in saved if isinstance(key, list)}
        keep = frame.apply(lambda row: tuple(_row_key(file, sheet, row)) not in deleted, axis=1)
        removed += int((~keep).sum())
        frames[(file, sheet)] = frame.loc[keep].reset_index(drop=True)
    return removed


def _row_dates(frame, column):
    if column == "period":
        parsed = pd.to_datetime(frame[column].astype(str).str.strip(), format="%m/%Y", errors="coerce")
    else:
        parsed = pd.to_datetime(frame[column], errors="coerce", format="ISO8601")
        missing = parsed.isna() & frame[column].notna()
        if missing.any():
            parsed.loc[missing] = pd.to_datetime(frame.loc[missing, column].astype(str), errors="coerce", dayfirst=True, format="mixed")
    return parsed.dt.strftime("%Y-%m-%d")


def _module_frames(module):
    frames = {}
    for file, sheet, _ in MODULES[module]["tables"]:
        frames[(file, sheet)] = read_sheet(file, sheet).reindex(columns=SCHEMA[file][sheet]["cols"])
    apply_tombstones(frames)
    return frames


def _dated_rows(module, frames):
    """Trả Series ngày cho từng bảng; bảng con báo cáo dùng ngày của REPORTS."""
    result = {}
    report_dates = {}
    if module == "reports":
        reports = frames[("reports.xlsx", "REPORTS")]
        dates = _row_dates(reports, "date") if not reports.empty else pd.Series(dtype="object")
        report_dates = dict(zip(reports.get("id", pd.Series(dtype="object")).astype(str), dates))
    for file, sheet, column in MODULES[module]["tables"]:
        frame = frames[(file, sheet)]
        if column:
            result[(file, sheet)] = _row_dates(frame, column) if not frame.empty else pd.Series(index=frame.index, dtype="object")
        elif module == "reports":
            result[(file, sheet)] = frame.get("report_id", pd.Series(index=frame.index, dtype="object")).astype(str).map(report_dates)
    return result


def summary():
    modules = []
    for module, config in MODULES.items():
        frames = _module_frames(module)
        dated = _dated_rows(module, frames)
        counts = {}
        tables = []
        for file, sheet, _ in config["tables"]:
            frame = frames[(file, sheet)]
            table_counts = {}
            for value in dated[(file, sheet)].dropna():
                table_counts[value] = table_counts.get(value, 0) + 1
                counts[value] = counts.get(value, 0) + 1
            table_dates = [{"date": value, "rows": table_counts[value]} for value in sorted(table_counts)]
            tables.append({
                "id": sheet.lower(), "label": TABLE_LABELS.get(sheet, sheet), "rows": int(len(frame)),
                "from": table_dates[0]["date"] if table_dates else None,
                "to": table_dates[-1]["date"] if table_dates else None,
                "dates": table_dates,
            })
        dates = [{"date": value, "rows": counts[value]} for value in sorted(counts)]
        modules.append({
            "id": module, "label": config["label"], "rows": sum(item["rows"] for item in tables),
            "from": dates[0]["date"] if dates else None, "to": dates[-1]["date"] if dates else None,
            "dates": dates, "tables": tables,
        })
    store = load_store()
    return {"modules": modules, "history": store.get("history", [])[-20:][::-1]}


def purge(module, from_date, to_date, actor="system", table="all"):
    if module not in MODULES:
        raise ValueError("Module quản trị dữ liệu không hợp lệ")
    try:
        start = date.fromisoformat(from_date)
        end = date.fromisoformat(to_date)
    except ValueError as error:
        raise ValueError("Ngày bắt đầu/kết thúc phải theo định dạng YYYY-MM-DD") from error
    if start > end:
        raise ValueError("Ngày bắt đầu không được sau ngày kết thúc")

    allowed_tables = {sheet.lower() for _, sheet, _ in MODULES[module]["tables"]}
    if table != "all" and table not in allowed_tables:
        raise ValueError("Nhóm dữ liệu không thuộc module đã chọn")

    frames = _module_frames(module)
    dated = _dated_rows(module, frames)
    selected = {}
    for file, sheet, _ in MODULES[module]["tables"]:
        row_dates = dated[(file, sheet)]
        in_scope = table == "all" or sheet.lower() == table
        selected[(file, sheet)] = (row_dates.notna() & row_dates.between(from_date, to_date)) if in_scope else pd.Series(False, index=frames[(file, sheet)].index)
    if module == "reports" and table == "reports":
        report_mask = selected[("reports.xlsx", "REPORTS")]
        report_ids = set(frames[("reports.xlsx", "REPORTS")].loc[report_mask, "id"].astype(str))
        for child in ("REPORT_STOCKS", "REPORT_SECTORS", "REPORT_RISKS"):
            frame = frames[("reports.xlsx", child)]
            selected[("reports.xlsx", child)] = frame["report_id"].astype(str).isin(report_ids)
    removed = sum(int(mask.sum()) for mask in selected.values())
    if not removed:
        raise ValueError("Không có bản ghi nào trong khoảng ngày đã chọn")

    store = load_store()
    for (file, sheet), mask in selected.items():
        frame = frames[(file, sheet)]
        table_id = _table_id(file, sheet)
        existing = {tuple(map(str, key)) for key in store["tables"].get(table_id, []) if isinstance(key, list)}
        existing.update(tuple(_row_key(file, sheet, row)) for _, row in frame.loc[mask].iterrows())
        store["tables"][table_id] = [list(key) for key in sorted(existing)]

    event = {
        "id": str(uuid4()), "module": module, "moduleLabel": MODULES[module]["label"],
        "table": table, "tableLabel": "Tất cả nhóm dữ liệu" if table == "all" else TABLE_LABELS.get(table.upper(), table),
        "from": from_date, "to": to_date, "rows": removed, "actor": actor,
        "at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    store["history"] = (store.get("history", []) + [event])[-100:]
    save_store(store)

    grouped = {}
    for (file, sheet), frame in frames.items():
        grouped.setdefault(file, {})[sheet] = frame.loc[~selected[(file, sheet)]].reset_index(drop=True)
    for file, file_frames in grouped.items():
        write_sheets(file, file_frames)
    return event


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("summary")
    delete = sub.add_parser("purge")
    delete.add_argument("--module", required=True, choices=tuple(MODULES))
    delete.add_argument("--from-date", required=True)
    delete.add_argument("--to-date", required=True)
    delete.add_argument("--actor", default="system")
    delete.add_argument("--table", default="all")
    args = parser.parse_args()
    if args.command == "summary":
        print(json.dumps(summary(), ensure_ascii=False))
    else:
        print(json.dumps(purge(args.module, args.from_date, args.to_date, args.actor, args.table), ensure_ascii=False))


if __name__ == "__main__":
    main()

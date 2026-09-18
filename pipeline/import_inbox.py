"""Chuyển báo cáo lưu từ giao diện (data/inbox/reports.jsonl) vào reports.xlsx."""
import json
import pandas as pd
from config import INBOX_DIR
from xlsx_io import read_sheet, upsert, write_sheets

INBOX = INBOX_DIR / "reports.jsonl"
CHANGES = INBOX_DIR / "report_changes.jsonl"


def report_frames(report):
    """Chuẩn hóa payload API thành 4 sheet của reports.xlsx."""
    rid = report["id"]
    return {
        "REPORTS": pd.DataFrame([{
            "id": rid, "broker": report.get("broker"), "date": report.get("date"), "type": report.get("type"),
            "title": report.get("title"), "stance": report.get("stance"), "vn_target": report.get("vnTarget"),
            "horizon": report.get("horizon"), "summary": report.get("summary"), "source": report.get("source"),
        }]),
        "REPORT_STOCKS": pd.DataFrame([{"report_id": rid, "ticker": s["t"], "rec": s.get("rec"), "target": s.get("target")}
                                      for s in report.get("stocks", [])]),
        "REPORT_SECTORS": pd.DataFrame(
            [{"report_id": rid, "sector": s, "view": "OW"} for s in report.get("ow", [])]
            + [{"report_id": rid, "sector": s, "view": "UW"} for s in report.get("uw", [])]
        ),
        "REPORT_RISKS": pd.DataFrame([{"report_id": rid, "topic": r["k"], "severity": r.get("s", 2)}
                                      for r in report.get("risks", [])]),
    }


def apply_changes():
    """Áp dụng sửa/xóa báo cáo vào Excel nguồn bằng một lần ghi atomic."""
    if not CHANGES.exists() or not CHANGES.read_text(encoding="utf-8").strip():
        return 0
    changes = [json.loads(line) for line in CHANGES.read_text(encoding="utf-8").splitlines() if line.strip()]
    frames = {sheet: read_sheet("reports.xlsx", sheet) for sheet in ("REPORTS", "REPORT_STOCKS", "REPORT_SECTORS", "REPORT_RISKS")}
    for change in changes:
        action, rid = change.get("action"), str(change.get("id", ""))
        if not rid or action not in ("upsert", "delete"):
            raise ValueError("Thay đổi báo cáo trong inbox không hợp lệ")
        frames["REPORTS"] = frames["REPORTS"][frames["REPORTS"].id.astype(str) != rid]
        for sheet in ("REPORT_STOCKS", "REPORT_SECTORS", "REPORT_RISKS"):
            frames[sheet] = frames[sheet][frames[sheet].report_id.astype(str) != rid]
        if action == "upsert":
            report = change.get("report")
            if not isinstance(report, dict) or str(report.get("id", "")) != rid:
                raise ValueError("Payload cập nhật báo cáo không hợp lệ")
            for sheet, new in report_frames(report).items():
                if not new.empty:
                    frames[sheet] = pd.concat([frames[sheet], new], ignore_index=True)
    write_sheets("reports.xlsx", frames)
    archive = INBOX_DIR / "report_changes_imported.jsonl"
    with archive.open("a", encoding="utf-8") as f:
        f.write(CHANGES.read_text(encoding="utf-8"))
    CHANGES.write_text("", encoding="utf-8")
    print(f"  Đã áp dụng {len(changes)} thay đổi báo cáo")
    return len(changes)


def run():
    if not INBOX.exists() or not INBOX.read_text(encoding="utf-8").strip():
        print("  Inbox trống"); return 0
    reps, stocks, sectors, risks = [], [], [], []
    for line in INBOX.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        reps.append({k: r.get(k) for k in ["id", "broker", "date", "type", "title", "stance", "horizon", "summary", "source"]}
                    | {"vn_target": r.get("vnTarget")})
        stocks += [{"report_id": r["id"], "ticker": s["t"], "rec": s.get("rec"), "target": s.get("target")} for s in r.get("stocks", [])]
        sectors += [{"report_id": r["id"], "sector": s, "view": "OW"} for s in r.get("ow", [])]
        sectors += [{"report_id": r["id"], "sector": s, "view": "UW"} for s in r.get("uw", [])]
        risks += [{"report_id": r["id"], "topic": k["k"], "severity": k.get("s", 2)} for k in r.get("risks", [])]
    upsert("reports.xlsx", "REPORTS", pd.DataFrame(reps))
    for sh, rows in [("REPORT_STOCKS", stocks), ("REPORT_SECTORS", sectors), ("REPORT_RISKS", risks)]:
        if rows:
            upsert("reports.xlsx", sh, pd.DataFrame(rows))
    archive = INBOX_DIR / "reports_imported.jsonl"
    with archive.open("a", encoding="utf-8") as f:
        f.write(INBOX.read_text(encoding="utf-8"))
    INBOX.write_text("", encoding="utf-8")
    print(f"  Đã nhập {len(reps)} báo cáo từ inbox")
    return len(reps)


def run_all():
    return run() + apply_changes()


if __name__ == "__main__":
    run_all()

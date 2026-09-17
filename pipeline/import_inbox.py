"""Chuyển báo cáo lưu từ giao diện (data/inbox/reports.jsonl) vào reports.xlsx."""
import json
import pandas as pd
from config import INBOX_DIR
from xlsx_io import upsert

INBOX = INBOX_DIR / "reports.jsonl"


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


if __name__ == "__main__":
    run()

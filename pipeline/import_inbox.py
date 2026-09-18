"""Chuyển các yêu cầu báo cáo từ inbox vào reports.xlsx một cách không mất dữ liệu."""
import json
from pathlib import Path
from uuid import uuid4

import pandas as pd

from config import INBOX_DIR
from xlsx_io import read_sheet, write_sheets


# report_jobs là hàng đợi hiện hành. Hai file cũ vẫn được đọc để nâng cấp
# Railway Volume mà không làm mất yêu cầu đã được ghi trước khi triển khai bản này.
JOBS = INBOX_DIR / "report_jobs.jsonl"
LEGACY_INBOX = INBOX_DIR / "reports.jsonl"
LEGACY_CHANGES = INBOX_DIR / "report_changes.jsonl"
SHEETS = ("REPORTS", "REPORT_STOCKS", "REPORT_SECTORS", "REPORT_RISKS")


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


def claim(path: Path):
    """Tách atomically phần inbox hiện tại để request mới luôn ghi vào file mới."""
    if not path.exists() or not path.read_text(encoding="utf-8").strip():
        return None
    claimed = path.with_name(f".{path.stem}.processing-{uuid4().hex}{path.suffix}")
    path.replace(claimed)
    return claimed


def pending_files(path: Path):
    """Lấy cả các lô còn dở dang sau một lần pipeline bị dừng."""
    previous = sorted(path.parent.glob(f".{path.stem}.processing-*{path.suffix}"))
    current = claim(path)
    return previous + ([current] if current else [])


def read_jsonl(path: Path):
    try:
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    except json.JSONDecodeError as error:
        raise ValueError(f"Inbox báo cáo lỗi JSON ({path.name}, dòng {error.lineno})") from error


def remove_report(frames, report_id):
    frames["REPORTS"] = frames["REPORTS"][frames["REPORTS"].id.astype(str) != report_id]
    for sheet in SHEETS[1:]:
        frames[sheet] = frames[sheet][frames[sheet].report_id.astype(str) != report_id]


def apply_job(frames, job):
    action, report_id = job.get("action"), str(job.get("id", ""))
    if action not in ("upsert", "delete") or not report_id:
        raise ValueError("Thay đổi báo cáo trong inbox không hợp lệ")
    remove_report(frames, report_id)
    if action == "upsert":
        report = job.get("report")
        if not isinstance(report, dict) or str(report.get("id", "")) != report_id:
            raise ValueError("Payload cập nhật báo cáo không hợp lệ")
        for sheet, rows in report_frames(report).items():
            if not rows.empty:
                frames[sheet] = pd.concat([frames[sheet], rows], ignore_index=True)


def legacy_jobs(path: Path, kind: str):
    """Chuyển định dạng inbox cũ sang cùng hàng đợi mới, vẫn giữ đúng thứ tự file."""
    rows = read_jsonl(path)
    if kind == "create":
        return [{"action": "upsert", "id": str(row.get("id", "")), "report": row} for row in rows]
    return rows


def archive_and_remove(path: Path, archive_name: str):
    archive = INBOX_DIR / archive_name
    with archive.open("a", encoding="utf-8") as file:
        file.write(path.read_text(encoding="utf-8"))
    path.unlink()


def run_all():
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    batches = []
    for path, kind, archive in (
        (LEGACY_INBOX, "create", "reports_imported.jsonl"),
        (LEGACY_CHANGES, "change", "report_changes_imported.jsonl"),
        (JOBS, "change", "report_jobs_imported.jsonl"),
    ):
        batches.extend((claimed, kind, archive) for claimed in pending_files(path))
    if not batches:
        print("  Inbox trống")
        return 0

    # Đọc và kiểm tra toàn bộ trước khi chạm vào Excel; file processing được giữ
    # nguyên khi có lỗi để operator có thể sửa/retry mà không mất yêu cầu.
    parsed = [(path, archive, legacy_jobs(path, kind)) for path, kind, archive in batches]
    frames = {sheet: read_sheet("reports.xlsx", sheet) for sheet in SHEETS}
    count = 0
    for _, _, jobs in parsed:
        for job in jobs:
            apply_job(frames, job)
            count += 1
    write_sheets("reports.xlsx", frames)
    for path, archive, _ in parsed:
        archive_and_remove(path, archive)
    print(f"  Đã áp dụng {count} thay đổi báo cáo")
    return count


def run():
    """Tương thích ngược với các lệnh gọi cũ."""
    return run_all()


def apply_changes():
    """Tương thích ngược với các lệnh gọi cũ."""
    return run_all()


if __name__ == "__main__":
    run_all()

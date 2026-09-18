"""Regression tests for the atomic report inbox importer."""
import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


PIPELINE_DIR = Path(__file__).resolve().parent


def report(report_id):
    return {
        "id": report_id, "broker": "Test", "date": "2026-09-18", "type": "Chiến lược",
        "title": report_id, "stance": "Trung lập", "vnTarget": None, "horizon": "",
        "summary": "", "source": "test", "stocks": [], "ow": [], "uw": [], "risks": [],
    }


class ImportInboxTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        sys.path.insert(0, str(PIPELINE_DIR))
        self.modules = ["config", "schema", "xlsx_io", "import_inbox"]
        for name in self.modules:
            sys.modules.pop(name, None)
        with patch.dict(os.environ, {"CALIDA_DATA_DIR": self.tmp.name}):
            self.importer = importlib.import_module("import_inbox")
            self.xlsx = importlib.import_module("xlsx_io")

    def tearDown(self):
        for name in self.modules:
            sys.modules.pop(name, None)
        sys.path.remove(str(PIPELINE_DIR))
        self.tmp.cleanup()

    def append_job(self, value):
        self.importer.JOBS.parent.mkdir(parents=True, exist_ok=True)
        with self.importer.JOBS.open("a", encoding="utf-8") as file:
            file.write(json.dumps(value) + "\n")

    def test_job_arriving_during_import_is_processed_next_run(self):
        self.append_job({"action": "upsert", "id": "R1", "report": report("R1")})
        real_claim = self.importer.claim
        appended = False

        def claim_then_append(path):
            nonlocal appended
            claimed = real_claim(path)
            if path == self.importer.JOBS and claimed and not appended:
                appended = True
                self.append_job({"action": "upsert", "id": "R2", "report": report("R2")})
            return claimed

        with patch.object(self.importer, "claim", side_effect=claim_then_append):
            self.assertEqual(self.importer.run_all(), 1)
        self.assertTrue(self.importer.JOBS.exists(), "job mới phải ở lại inbox cho lần chạy sau")
        self.assertEqual(self.importer.run_all(), 1)
        rows = self.xlsx.read_sheet("reports.xlsx", "REPORTS")
        self.assertEqual(set(rows.id.astype(str)), {"R1", "R2"})


if __name__ == "__main__":
    unittest.main()

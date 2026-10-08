"""Negative controls for the completion gate; no network or server startup."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("completion", Path(__file__).with_name("verify-completion.py"))
completion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(completion)


class CompletionAuditTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        # A valid small repo fixture keeps the failure under test independent of
        # unrelated future documentation edits and local build products.
        for name in completion.REQUIRED_BUNDLE_FILES:
            self.write("submission/qyl/" + name, "fixture")
        for name in completion.REQUIRED_HANDOFF_FILES:
            self.write(name, "# Fixture\n")
        for name in ("README.md", "AGENTS.md", "goal-objective.md", "MCP-CHECKPOINT.md", "QYL-MCP-MATRIX.md", "MCP-V2-INTEROP-TODO.md"):
            self.write(name, "# Fixture\n")
        for name in ("submission/qyl/plugin.json", "submission/qyl/mcp.json", "submission/schemas/plugin.schema.json", "submission/schemas/mcp.schema.json", "server/tool-manifest.snapshot.json", "server/src/native-execution.ts"):
            self.write(name, (completion.ROOT / name).read_text())
        self.write("submission/qyl/README.md", "# Fixture\n\n" + "Useful instructions. " * 25)

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def audit(self):
        return completion.audit(self.root)

    def test_accepts_valid_fixture(self):
        self.assertTrue(self.audit()[-1].startswith("Completion audit passed"))

    def test_missing_bundle_and_handoff_files_fail(self):
        for name in ("submission/qyl/assets/qyl-icon.png", "submission/qyl/skills/qyl-investigate/SKILL.md", "release/contract.md"):
            with self.subTest(name=name):
                path = self.root / name
                saved = path.read_bytes()
                path.unlink()
                with self.assertRaisesRegex(completion.AuditFailure, "missing"):
                    self.audit()
                path.write_bytes(saved)

    def test_both_manifests_use_real_nested_schema_validation(self):
        for name, value in (("plugin", {"author": {"name": 7}}), ("mcp", {"mcpServers": {"bad": {"type": "streamable-http", "url": 7}}})):
            with self.subTest(name=name):
                path = self.root / f"submission/qyl/{name}.json"
                saved = path.read_text()
                document = json.loads(saved)
                document.update(value)
                path.write_text(json.dumps(document))
                with self.assertRaisesRegex(completion.AuditFailure, name + r"\.json"):
                    self.audit()
                path.write_text(saved)

    def test_readme_code_blocks_do_not_meet_word_minimum(self):
        self.write("submission/qyl/README.md", "# Tiny\n\n~~~text\n" + "padding " * 100 + "\n~~~\n")
        with self.assertRaisesRegex(completion.AuditFailure, "words outside code blocks"):
            self.audit()

    def test_all_descriptions_must_have_user_need_without_model_orders(self):
        path = self.root / "server/tool-manifest.snapshot.json"
        saved = path.read_text()
        for description in ("Reads telemetry.", "Use when the user needs traces. The model must call this first."):
            with self.subTest(description=description):
                value = json.loads(saved)
                value["tools"][-1]["description"] = description
                path.write_text(json.dumps(value))
                with self.assertRaisesRegex(completion.AuditFailure, "description"):
                    self.audit()
        value = json.loads(saved)
        value["tools"].pop()
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(completion.AuditFailure, "11 distinct tools"):
            self.audit()

    def test_record_payload_fields_and_unreviewed_shapes_fail_closed(self):
        path = self.root / "server/src/native-execution.ts"
        saved = path.read_text()
        for change in ("arguments: z.unknown(),", "_meta: z.unknown(),", "...otherFields,", "['arguments']: z.unknown(),"):
            with self.subTest(change=change):
                path.write_text(saved.replace("id: IdentifierSchema,", "id: IdentifierSchema,\n  " + change, 1))
                with self.assertRaisesRegex(completion.AuditFailure, "native record"):
                    self.audit()
        path.write_text(saved.replace("}).strict();", "}).passthrough();", 1))
        with self.assertRaisesRegex(completion.AuditFailure, "native record"):
            self.audit()

    def test_ledger_missing_evidence_is_rejected_but_transcripts_remain_data(self):
        self.write("MCP-V2-INTEROP-TODO.md", "| Check | Evidence |\n| --- | --- |\n| fixture | **not** recorded |\n")
        with self.assertRaisesRegex(completion.AuditFailure, "not recorded"):
            self.audit()
        self.write("MCP-V2-INTEROP-TODO.md", "```text\n| historical | not recorded |\n```\n")
        self.audit()

    def test_local_links_and_fragments_include_reference_links(self):
        self.write("release/contract.md", "# Same `heading`\n\n# Same `heading`\n")
        self.write("release/README.md", "[valid][ref]\n\n[ref]: contract.md#same-heading-1\n\n```md\n[example](missing.md)\n```\n")
        self.audit()
        for target in ("missing.md", "contract.md#missing", "../../../outside.md"):
            with self.subTest(target=target):
                self.write("release/README.md", f"[broken][ref]\n\n[ref]: {target}\n")
                with self.assertRaisesRegex(completion.AuditFailure, "missing|escapes repository"):
                    self.audit()


if __name__ == "__main__":
    unittest.main()

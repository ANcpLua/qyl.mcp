"""Exercise the real login CLI's profile/output selection without authenticating."""
from pathlib import Path
import subprocess
import sys
import unittest

HERE = Path(__file__).resolve().parent


class LoginArgumentsTests(unittest.TestCase):
    def invoke(self, *arguments):
        return subprocess.run(
            [sys.executable, str(HERE / "login.py"), "--print-token-path", *arguments],
            capture_output=True, text=True, timeout=10, check=False,
        )

    def test_owner_and_default_profiles_resolve_different_token_files(self):
        default = self.invoke()
        owner = self.invoke("--profile", "owner", "--scope", "qyl:read qyl:write qyl:delete offline_access")
        self.assertEqual(default.returncode, 0, default.stderr)
        self.assertEqual(owner.returncode, 0, owner.stderr)
        self.assertEqual(Path(default.stdout.strip()), HERE / "out/hosted-token.json")
        self.assertEqual(Path(owner.stdout.strip()), HERE / "out/hosted-owner-token.json")
        self.assertNotEqual(default.stdout, owner.stdout)

    def test_explicit_output_takes_precedence_over_the_profile_default(self):
        result = self.invoke("--profile", "owner", "--out", "chosen-token.json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "chosen-token.json")

    def test_invalid_profile_is_rejected_before_authentication(self):
        result = self.invoke("--profile", "../owner")
        self.assertEqual(result.returncode, 2)
        self.assertIn("--profile must be a single name", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_empty_scope_is_rejected_before_authentication(self):
        result = self.invoke("--scope", " ")
        self.assertEqual(result.returncode, 2)
        self.assertIn("--scope must contain at least one scope", result.stderr)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()

import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "skill/linkora-management/scripts/linkora.py"
SPEC = importlib.util.spec_from_file_location("linkora_skill", SCRIPT)
linkora = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(linkora)


class ApiHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def handle_api(self):
        size = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(size)) if size else None
        self.server.calls.append((self.command, self.path, dict(self.headers), body))
        authenticated = (self.headers.get("Cookie") == "linkora_session=test-session"
                         and not self.server.revoked)
        status, headers = 200, {}
        result = {}
        if self.path == "/api/v1/auth/login":
            if (body != {"email": "owner@example.test", "password": "test-password"}
                    or self.headers.get("Origin") != self.server.origin):
                status = 401
            else:
                self.server.revoked = False
                headers["Set-Cookie"] = "linkora_session=test-session; Path=/api; HttpOnly; Max-Age=600"
                result = {"authenticated": True, "csrfToken": "test-csrf", "owner": {"email": body["email"]}}
        elif self.path == "/api/v1/auth/me":
            result = {"authenticated": authenticated}
            if authenticated:
                result["csrfToken"] = "test-csrf"
        elif self.path == "/api/v1/redirect":
            status = 302
            headers["Location"] = self.server.origin + "/api/v1/redirect-target"
        elif self.command != "GET":
            if not authenticated:
                status = 401
            elif (self.headers.get("Origin") != self.server.origin
                  or self.headers.get("X-Csrf-Token") != "test-csrf"):
                status = 403
            elif self.path == "/api/v1/auth/logout":
                self.server.revoked = True
                result = {"authenticated": False}
            elif self.path == "/api/v1/failure":
                status = 503
                result = {"message": "do-not-echo-sensitive-server-body"}
            elif self.path.endswith("/preview"):
                result = {"revision": 7, "affectedBookmarks": 1}
            else:
                result = {"id": "test-id", **(body or {})}
        else:
            result = {"items": [{"title": "private" if authenticated else "public"}], "total": 1}
        content = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(content)

    do_GET = do_POST = do_PATCH = do_DELETE = handle_api


class LinkoraClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), ApiHandler)
        cls.server.origin = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.environment = patch.dict(os.environ, {
            "LINKORA_EMAIL": "owner@example.test", "LINKORA_PASSWORD": "test-password",
            "LINKORA_SESSION_DIR": self.directory.name, "NO_PROXY": "127.0.0.1",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.server.calls = []
        self.server.revoked = False

    def client(self, **kwargs):
        return linkora.Client(self.server.origin, **kwargs)

    def test_session_reuse_csrf_and_private_cache_permissions(self):
        client = self.client()
        self.assertEqual(client.request("GET", "/bookmarks")["items"][0]["title"], "private")
        self.assertEqual(stat.S_IMODE(client.cookie_file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(client.cookie_file.parent.stat().st_mode), 0o700)
        with patch.dict(os.environ, {"LINKORA_EMAIL": "", "LINKORA_PASSWORD": ""}):
            result = self.client().request("PATCH", "/bookmarks/test-id", {"title": "更新"}, apply=True)
        self.assertEqual(result["title"], "更新")
        logins = [call for call in self.server.calls if call[1] == "/api/v1/auth/login"]
        self.assertEqual(len(logins), 1)

    def test_anonymous_does_not_use_owner_cookie(self):
        self.client().login()
        result = self.client(anonymous=True).request("GET", "/bookmarks")
        self.assertEqual(result["items"][0]["title"], "public")
        self.assertNotIn("Cookie", self.server.calls[-1][2])

    def test_write_guard_rejects_before_network(self):
        client = self.client()
        for method, path in [("POST", "/bookmarks"), ("PATCH", "/preferences"),
                             ("DELETE", "/categories/test-id"), ("POST", "/bookmarks/export")]:
            with self.subTest(method=method, path=path), self.assertRaises(linkora.ClientError):
                client.request(method, path, {})
        self.assertEqual(self.server.calls, [])

    def test_preview_and_commit_preserve_explicit_body(self):
        client = self.client()
        body = {"operation": "SET_FAVORITE", "bookmarkIds": ["test-id"], "payload": {"value": True}}
        result = client.request("POST", "/bookmarks/batch/preview", body)
        confirmed = {**body, "expectedRevision": result["revision"]}
        client.request("POST", "/bookmarks/batch", confirmed, apply=True)
        self.assertEqual(self.server.calls[-1][3], confirmed)

    def test_untrusted_paths_rejected_before_network_and_cache_is_site_scoped(self):
        client = self.client()
        for path in ["https://example.test/bookmarks", "//example.test/bookmarks", "/../auth/me",
                     "/%2e%2e/auth/me", "/bookmarks#fragment", "/bookmarks\n"]:
            with self.subTest(path=path), self.assertRaises(linkora.ClientError):
                client.request("GET", path)
        other = linkora.Client("https://example.test")
        self.assertNotEqual(client.cookie_file, other.cookie_file)
        self.assertEqual(len(other.cookies), 0)
        self.assertEqual(self.server.calls, [])

    def test_redirect_is_not_followed(self):
        with self.assertRaisesRegex(linkora.ClientError, "302"):
            self.client(anonymous=True).request("GET", "/redirect")
        self.assertEqual([call[1] for call in self.server.calls], ["/api/v1/redirect"])

    def test_expired_session_reauthenticates_once_and_failed_write_is_not_replayed(self):
        client = self.client()
        client.login()
        self.server.revoked = True
        with self.assertRaisesRegex(linkora.ClientError, "HTTP 503") as error:
            client.request("POST", "/failure", {}, apply=True)
        self.assertNotIn("sensitive-server-body", str(error.exception))
        self.assertEqual(len([call for call in self.server.calls if call[1] == "/api/v1/auth/login"]), 2)
        self.assertEqual(len([call for call in self.server.calls if call[1] == "/api/v1/failure"]), 1)

    def test_logout_clears_cache_and_does_not_silently_read_as_visitor(self):
        client = self.client()
        client.login()
        self.assertEqual(client.logout(), {"authenticated": False})
        self.assertEqual(len(self.client().cookies), 0)
        with patch.dict(os.environ, {"LINKORA_EMAIL": "", "LINKORA_PASSWORD": ""}):
            with self.assertRaisesRegex(linkora.ClientError, "LINKORA_EMAIL"):
                self.client().request("GET", "/bookmarks")
        self.assertNotIn("/api/v1/bookmarks", [call[1] for call in self.server.calls])

    def test_cli_login_output_omits_credentials_and_csrf(self):
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--base-url", self.server.origin, "login"],
                                capture_output=True, text=True, check=True)
        self.assertTrue(json.loads(result.stdout)["authenticated"])
        for secret in ["test-password", "test-session", "test-csrf", "csrfToken"]:
            self.assertNotIn(secret, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()

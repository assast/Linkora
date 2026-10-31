#!/usr/bin/env python3
"""Linkora API client with site-scoped sessions; Python 3 standard library only."""

import argparse
import getpass
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request


class ClientError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def site_origin(value):
    parts = urllib.parse.urlsplit(value)
    if (parts.scheme not in ("http", "https") or not parts.hostname
            or parts.username is not None or parts.password is not None
            or parts.path not in ("", "/") or parts.query or parts.fragment):
        raise ClientError("LINKORA_BASE_URL 必须是无凭据、路径和查询参数的站点根地址")
    host = parts.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    port = parts.port
    suffix = f":{port}" if port and port != {"http": 80, "https": 443}[parts.scheme] else ""
    return f"{parts.scheme}://{host}{suffix}"


def api_path(value):
    parts = urllib.parse.urlsplit(value)
    if (not value.startswith("/") or value.startswith("//") or parts.scheme or parts.netloc
            or parts.fragment or not re.fullmatch(r"/[A-Za-z0-9/_-]*", parts.path)
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise ClientError("路径必须为当前站点 API 相对路径，例如 /bookmarks?page=1")
    return value


def redact(value):
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items() if key != "csrfToken"}
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


class Client:
    def __init__(self, base_url, session_dir=None, anonymous=False):
        self.origin = site_origin(base_url)
        self.anonymous = anonymous
        self.csrf = None
        self.cookie_file = None
        if anonymous:
            self.cookies = http.cookiejar.CookieJar()
        else:
            directory = Path(session_dir or os.environ.get("LINKORA_SESSION_DIR")
                             or Path.home() / ".cache" / "linkora").expanduser()
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            directory.chmod(0o700)
            key = hashlib.sha256(self.origin.encode()).hexdigest()[:24]
            self.cookie_file = directory / f"{key}.cookies"
            self.cookies = http.cookiejar.MozillaCookieJar(str(self.cookie_file))
            if self.cookie_file.exists():
                self.cookie_file.chmod(0o600)
                self.cookies.load(ignore_discard=True)
        self.opener = urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPCookieProcessor(self.cookies))

    def save_session(self):
        if self.cookie_file is None:
            return
        descriptor, temporary = tempfile.mkstemp(dir=self.cookie_file.parent)
        os.close(descriptor)
        try:
            self.cookies.save(temporary, ignore_discard=True)
            os.replace(temporary, self.cookie_file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def call(self, method, path, body=None):
        path = api_path(path)
        headers = {"Accept": "application/json"}
        if method != "GET":
            headers["Origin"] = self.origin
            if self.csrf:
                headers["X-CSRF-Token"] = self.csrf
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.origin + "/api/v1" + path,
                                         data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=30) as response:
                content = response.read()
                return json.loads(content) if content else None
        except urllib.error.HTTPError as error:
            hints = {400: "核对请求字段", 401: "会话失效或凭据错误", 403: "核对站点来源和 CSRF",
                     404: "内容不存在或当前身份不可见", 409: "重新读取/预览后再操作",
                     429: "登录限流，请稍后重试", 503: "数据库未就绪"}
            hint = "入口发生重定向，请配置最终站点源" if 300 <= error.code < 400 else hints.get(error.code, "服务请求失败")
            error.close()
            raise ClientError(f"HTTP {error.code}：{hint}") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            raise ClientError("连接失败或超时；写请求请先读回核对，不要直接重试") from None

    def login(self, prompt=False):
        if self.anonymous:
            raise ClientError("匿名模式不能登录")
        email = os.environ.get("LINKORA_EMAIL")
        password = os.environ.get("LINKORA_PASSWORD")
        if prompt and sys.stdin.isatty():
            email = email or input("Linkora 邮箱: ")
            password = password or getpass.getpass("Linkora 密码: ")
        if not email or not password:
            raise ClientError("请配置 LINKORA_EMAIL 与 LINKORA_PASSWORD，或在终端交互运行 login")
        identity = self.call("POST", "/auth/login", {"email": email, "password": password})
        self.csrf = identity["csrfToken"]
        self.save_session()
        return identity

    def authenticate(self):
        identity = self.call("GET", "/auth/me")
        if identity.get("authenticated"):
            self.csrf = identity["csrfToken"]
        else:
            self.login()

    def logout(self):
        if self.anonymous:
            raise ClientError("匿名模式没有所有者会话")
        identity = self.call("GET", "/auth/me")
        if identity.get("authenticated"):
            self.csrf = identity["csrfToken"]
            self.call("POST", "/auth/logout")
        self.cookies.clear()
        self.save_session()
        return {"authenticated": False}

    def request(self, method, path, body=None, apply=False):
        api_path(path)
        route = urllib.parse.urlsplit(path).path
        if method not in ("GET", "POST", "PATCH", "DELETE"):
            raise ClientError("只支持 GET、POST、PATCH、DELETE")
        preview = method == "POST" and (route == "/bookmarks/batch/preview" or re.fullmatch(
            r"/(bookmarks|categories)/[0-9a-fA-F-]{36}/preview", route))
        if route in ("/auth/login", "/auth/logout"):
            raise ClientError("会话管理请使用 login / logout 子命令")
        if method != "GET" and not preview and not apply:
            raise ClientError("实际写入和导出需要 --apply；先核对操作范围与预览")
        if method == "GET" and body is not None:
            raise ClientError("GET 不接受请求体，请将条件放入查询参数")
        if self.anonymous and method != "GET":
            raise ClientError("匿名模式仅允许 GET")
        if not self.anonymous:
            self.authenticate()
        return self.call(method, path, body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.environ.get("LINKORA_BASE_URL"))
    parser.add_argument("--anonymous", action="store_true", help="不读取所有者会话，仅作访客查询")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("login", help="登录并缓存站点会话")
    commands.add_parser("logout", help="注销当前站点会话")
    request = commands.add_parser("request", help="调用 /api/v1 下的接口")
    request.add_argument("method", choices=["GET", "POST", "PATCH", "DELETE"])
    request.add_argument("path", help="例如 /bookmarks?page=1；省略 /api/v1 前缀")
    request.add_argument("--body-file", type=Path)
    request.add_argument("--apply", action="store_true", help="执行实际写入或导出")
    args = parser.parse_args()
    try:
        if not args.base_url:
            raise ClientError("请设置 LINKORA_BASE_URL 或传入 --base-url")
        body = None
        if args.command == "request" and args.body_file:
            body = json.loads(args.body_file.read_text(encoding="utf-8"))
            if not isinstance(body, dict):
                raise ClientError("请求文件必须为 JSON 对象")
        client = Client(args.base_url, anonymous=args.anonymous)
        if args.command == "login":
            result = client.login(prompt=True)
        elif args.command == "logout":
            result = client.logout()
        else:
            result = client.request(args.method, args.path, body, apply=args.apply)
        print(json.dumps(redact(result), ensure_ascii=False, indent=2))
        return 0
    except (ClientError, OSError, ValueError, http.cookiejar.LoadError) as error:
        message = str(error) if isinstance(error, ClientError) else "本地配置、JSON 或会话文件无效，请核对后重试"
        print(message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

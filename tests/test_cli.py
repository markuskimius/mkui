"""Tests for mkui CLI (mkui init, mkui serve)."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib


class TestVersion(unittest.TestCase):
    def test_version_flag(self):
        r = subprocess.run(["python", "-m", "mkui", "--version"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        self.assertRegex(r.stdout.strip(), r"^mkui \d+\.\d+\.\d+$")

    def test_short_version_flag(self):
        r = subprocess.run(["python", "-m", "mkui", "-V"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        self.assertIn("mkui", r.stdout)

    def test_no_subcommand_shows_help(self):
        r = subprocess.run(["python", "-m", "mkui"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("init", r.stdout)
        self.assertIn("serve", r.stdout)


class TestInit(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_creates_project_structure(self):
        target = os.path.join(self.tmpdir, "myapp")
        r = subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)

        self.assertTrue(os.path.isfile(os.path.join(target, "server.toml")))
        self.assertTrue(os.path.isfile(os.path.join(target, "static", "index.html")))
        self.assertTrue(os.path.isfile(os.path.join(target, "config", "client.toml")))

    def test_server_toml_is_valid_toml(self):
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        with open(os.path.join(target, "server.toml"), "rb") as f:
            config = tomllib.load(f)
        self.assertIn("port", config)
        self.assertIn("static", config)
        self.assertIn("config", config)

    def test_server_toml_has_mkui_static_route(self):
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        with open(os.path.join(target, "server.toml"), "rb") as f:
            config = tomllib.load(f)
        self.assertEqual(config["static"]["/mkui"], "<mkui.static_dir>")
        self.assertEqual(config["static"]["/"], "./static")

    def test_server_toml_has_config_route(self):
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        with open(os.path.join(target, "server.toml"), "rb") as f:
            config = tomllib.load(f)
        self.assertEqual(config["config"]["/config"], "./config")

    def test_client_toml_is_valid_toml(self):
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        with open(os.path.join(target, "config", "client.toml"), "rb") as f:
            config = tomllib.load(f)
        self.assertIn("app", config)
        self.assertIn("menubar", config)
        self.assertIn("statusbar", config)
        self.assertIn("panes", config)
        self.assertIn("frames", config)
        self.assertIn("mkio", config)

    def test_client_toml_has_auth_section(self):
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        with open(os.path.join(target, "config", "client.toml"), "rb") as f:
            config = tomllib.load(f)
        self.assertIn("auth", config)
        self.assertEqual(config["auth"]["method"], "mkio")

    def test_client_toml_auth_has_state_maps(self):
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        with open(os.path.join(target, "config", "client.toml"), "rb") as f:
            config = tomllib.load(f)
        self.assertIn("connected", config["auth"])
        self.assertIn("disconnected", config["auth"])
        self.assertIn("status.message", config["auth"]["connected"])
        self.assertIn("status.message", config["auth"]["disconnected"])

    def test_client_toml_has_help_about_and_asks_before_it_discards(self):
        """A new app starts with the popups wired: Help → About fed by the
        `app` block, and a `confirm` on the two items that throw work away."""
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        with open(os.path.join(target, "config", "client.toml"), "rb") as f:
            config = tomllib.load(f)
        self.assertTrue(config["app"].get("version"))
        self.assertTrue(config["app"].get("description"))
        items = [i for m in config["menubar"] for i in m.get("items", []) if isinstance(i, dict)]
        by_action = {i.get("action"): i for i in items}
        self.assertIn("dialog.about", by_action)
        self.assertEqual([m["label"] for m in config["menubar"]][-1], "Help", "Help comes last")
        for action in ("layout.reset", "auth.logout"):
            confirm = by_action[action].get("confirm")
            message = confirm if isinstance(confirm, str) else (confirm or {}).get("message")
            self.assertTrue(message, f"{action} asks first")

    def test_client_toml_has_account_menu(self):
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        with open(os.path.join(target, "config", "client.toml"), "rb") as f:
            config = tomllib.load(f)
        menus = config.get("menubar", [])
        account_menus = [m for m in menus if m.get("label") == "Account"]
        self.assertEqual(len(account_menus), 1)
        items = account_menus[0].get("items", [])
        logout_items = [i for i in items if i.get("action") == "auth.logout"]
        self.assertEqual(len(logout_items), 1)

    def test_client_toml_statusbar_has_auth_user_widget(self):
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        with open(os.path.join(target, "config", "client.toml"), "rb") as f:
            config = tomllib.load(f)
        right = config.get("statusbar", {}).get("right", [])
        auth_user_widgets = [w for w in right if w.get("bind") == "auth.user"]
        self.assertEqual(len(auth_user_widgets), 1)

    def test_client_toml_no_mkio_expect(self):
        """Auth-enabled template should not have mkio.expect (auth replaces verification)."""
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        with open(os.path.join(target, "config", "client.toml"), "rb") as f:
            config = tomllib.load(f)
        self.assertNotIn("expect", config.get("mkio", {}))

    def test_client_toml_no_mkio_incompatible(self):
        """Auth-enabled template should not have mkio.incompatible."""
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        with open(os.path.join(target, "config", "client.toml"), "rb") as f:
            config = tomllib.load(f)
        self.assertNotIn("incompatible", config.get("mkio", {}))

    def test_client_toml_no_mkio_disconnected(self):
        """Auth-enabled template should not have mkio.disconnected (uses auth.disconnected)."""
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        with open(os.path.join(target, "config", "client.toml"), "rb") as f:
            config = tomllib.load(f)
        self.assertNotIn("disconnected", config.get("mkio", {}))

    def test_client_toml_has_mkio_connected(self):
        """mkio.connected should exist to clear initial grey styling on WebSocket connect."""
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        with open(os.path.join(target, "config", "client.toml"), "rb") as f:
            config = tomllib.load(f)
        self.assertIn("connected", config.get("mkio", {}))
        self.assertEqual(config["mkio"]["connected"]["status.message"], "Connected")

    def test_client_toml_references_mkio_services(self):
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        with open(os.path.join(target, "config", "client.toml"), "rb") as f:
            config = tomllib.load(f)
        panes = config["panes"]
        self.assertEqual(panes["all-items"]["service"], "all_items")
        self.assertEqual(panes["all-items"]["protocol"], "query")
        self.assertEqual(panes["feed"]["service"], "feed")
        self.assertEqual(panes["feed"]["protocol"], "stream")

    def test_index_html_references_mkui_assets(self):
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        html = Path(os.path.join(target, "static", "index.html")).read_text()
        self.assertIn("/mkui/styles/mkui.css", html)
        self.assertIn("/mkui/src/index.js", html)
        self.assertIn("/config/client.json", html)

    def test_refuses_overwrite_client_toml(self):
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)
        r = subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("already exists", r.stderr)

    def test_prints_next_step(self):
        target = os.path.join(self.tmpdir, "myapp")
        r = subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True, text=True)
        self.assertIn("mkui serve", r.stdout)

    def test_creates_target_directory(self):
        target = os.path.join(self.tmpdir, "deep", "nested", "app")
        r = subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        self.assertTrue(os.path.isdir(target))


class TestMkioFloor(unittest.TestCase):
    """`mkui serve` refuses an mkio of another major before it imports it.

    mkui is built against mkio 1.x; semantic versioning means any 1.x
    serves, and a 2.x may not speak what `mkui/control.py` and the browser
    expect. A checkout with no package metadata cannot be judged and passes.
    """

    def test_the_built_against_major_passes(self):
        from mkui.__main__ import check_mkio, MKIO_MAJOR
        self.assertEqual(MKIO_MAJOR, 1)
        for v in ["1.0.0", "1.0", "1.7.2", "1.99.0"]:
            self.assertIsNone(check_mkio(v), v)

    def test_another_major_is_refused_with_the_versions_named(self):
        from mkui.__main__ import check_mkio
        from mkui import __version__
        for v in ["0.10.0", "0.5.1", "2.0.0"]:
            msg = check_mkio(v)
            self.assertIsNotNone(msg, v)
            self.assertIn(f"mkio {v}", msg)
            self.assertIn(f"mkui {__version__}", msg)
            self.assertIn("mkio 1.x", msg)

    def test_an_unreadable_version_is_not_judged(self):
        from mkui.__main__ import check_mkio
        for v in ["dev", "", "x.y"]:
            self.assertIsNone(check_mkio(v), repr(v))

    def test_reads_the_installed_metadata_when_not_given(self):
        import importlib.metadata
        from unittest import mock
        from mkui.__main__ import check_mkio
        with mock.patch.object(importlib.metadata, "version", return_value="2.0.0"):
            self.assertIsNotNone(check_mkio())
        with mock.patch.object(importlib.metadata, "version", return_value="1.4.0"):
            self.assertIsNone(check_mkio())
        with mock.patch.object(importlib.metadata, "version",
                               side_effect=importlib.metadata.PackageNotFoundError("mkio")):
            self.assertIsNone(check_mkio())

    def test_serve_exits_1_before_touching_the_project(self):
        import argparse
        import importlib.metadata
        import io
        from contextlib import redirect_stderr
        from unittest import mock
        from mkui.__main__ import cmd_serve
        args = argparse.Namespace(dir="/nonexistent/project", port=None, open=False)
        err = io.StringIO()
        with mock.patch.object(importlib.metadata, "version", return_value="0.10.0"), \
             redirect_stderr(err), self.assertRaises(SystemExit) as cm:
            cmd_serve(args)
        self.assertEqual(cm.exception.code, 1)
        self.assertIn("needs mkio 1.x", err.getvalue())
        self.assertIn("pip install 'mkio>=1.0,<2'", err.getvalue())
        # the missing project was never reached: the mkio message is the only one
        self.assertNotIn("not found", err.getvalue())

    def test_pyproject_declares_the_same_range(self):
        with open(Path(__file__).parent.parent / "pyproject.toml", "rb") as f:
            proj = tomllib.load(f)
        self.assertEqual(proj["project"]["optional-dependencies"]["mkio"], ["mkio>=1.0,<2"])


@unittest.skipIf(sys.platform == "win32", "emulates Windows' default text encoding on POSIX")
class TestInitEncoding(unittest.TestCase):
    """The scaffold is written as UTF-8 whatever the locale's encoding is.

    Windows' default text encoding is the ANSI code page (cp1252 in Western
    locales), which cannot hold the client template's box-drawing rules; and
    a TOML file is UTF-8 by definition, so a file written in the code page
    is one tomllib refuses at serve time. The child runs under an ASCII
    locale, stricter than any code page, with a stand-in `mkio` on PATH so
    only mkui's own writes are under test.
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        bindir = os.path.join(self.tmpdir, "bin")
        os.mkdir(bindir)
        fake = os.path.join(bindir, "mkio")
        with open(fake, "w", encoding="utf-8") as f:
            f.write('#!/bin/sh\nmkdir -p "$2" && printf \'port = 8080\\n\' > "$2/server.toml"\n')
        os.chmod(fake, 0o755)
        self.env = {
            **os.environ,
            "PATH": bindir + os.pathsep + os.environ.get("PATH", ""),
            "LC_ALL": "C", "LANG": "C", "PYTHONCOERCECLOCALE": "0", "PYTHONUTF8": "0",
        }
        probe = subprocess.run(
            [sys.executable, "-c", "import locale; print(locale.getpreferredencoding(False))"],
            capture_output=True, text=True, env=self.env,
        )
        if probe.stdout.strip().lower().replace("-", "") not in ("ascii", "usascii", "ansi_x3.41968"):
            self.skipTest(f"could not get an ASCII locale (got {probe.stdout.strip()!r})")

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_scaffold_is_utf8_under_an_ascii_locale(self):
        target = os.path.join(self.tmpdir, "myapp")
        r = subprocess.run(
            [sys.executable, "-m", "mkui", "init", target],
            capture_output=True, text=True, env=self.env,
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        for rel in ("server.toml", os.path.join("config", "client.toml")):
            with open(os.path.join(target, rel), "rb") as f:
                data = f.read()
            text = data.decode("utf-8")          # what tomllib does at serve time
            tomllib.loads(text)
        client = Path(target, "config", "client.toml").read_text(encoding="utf-8")
        self.assertIn("\u2500", client)          # the box-drawing rule cp1252 lacks
        self.assertIn("\u2014", Path(target, "server.toml").read_text(encoding="utf-8"))
        html = Path(target, "static", "index.html").read_bytes()
        self.assertIn(b'<meta charset="utf-8" />', html)
        self.assertIn(b"<mkui-app", html)

    def test_scaffold_has_no_carriage_returns(self):
        """The files are written in text mode: on Windows that turns every
        newline into CRLF, which TOML and HTML accept, but the scaffold must
        not depend on it — the same file must read identically everywhere."""
        target = os.path.join(self.tmpdir, "myapp")
        r = subprocess.run(
            [sys.executable, "-m", "mkui", "init", target],
            capture_output=True, text=True, env=self.env,
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        for rel in (os.path.join("config", "client.toml"), os.path.join("static", "index.html")):
            data = Path(target, rel).read_bytes()
            self.assertNotIn(b"\r", data, rel)


class TestServe(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_missing_server_toml(self):
        r = subprocess.run(
            ["python", "-m", "mkui", "serve", self.tmpdir],
            capture_output=True, text=True,
        )
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not found", r.stderr)

    def test_port_override(self):
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        proc = subprocess.Popen(
            ["python", "-m", "mkui", "serve", target, "-p", "18790"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            cwd=target,
        )
        try:
            import time
            time.sleep(3)
            import urllib.request
            r = urllib.request.urlopen("http://localhost:18790/")
            self.assertEqual(r.status, 200)
        finally:
            proc.terminate()
            proc.wait(timeout=5)

    def test_host_and_port_move_the_page_and_the_socket_together(self):
        """One listener: `-H`/`-p` move `/ws` with the page, the scaffolded
        client follows (`url = "/ws"`), and the banner names the address."""
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        proc = subprocess.Popen(
            ["python", "-m", "mkui", "serve", target, "-H", "127.0.0.1", "-p", "18794"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            cwd=target,
        )
        try:
            import asyncio, json, time, urllib.request
            from mkio.client import MkioClient
            time.sleep(3)
            r = urllib.request.urlopen("http://127.0.0.1:18794/config/client.json")
            self.assertEqual(json.loads(r.read())["mkio"]["url"], "/ws")

            async def dial():
                async with MkioClient("ws://127.0.0.1:18794/ws"):
                    return True
            self.assertTrue(asyncio.run(asyncio.wait_for(dial(), 5)))
        finally:
            proc.terminate()
            out, err = proc.communicate(timeout=5)
        self.assertIn("http://127.0.0.1:18794/", out)
        self.assertNotIn("Network:", out)
        self.assertNotIn("warning:", err)

    def test_warns_when_the_client_dials_another_port(self):
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)
        client = Path(target, "config", "client.toml")
        client.write_text(
            client.read_text(encoding="utf-8").replace('url = "/ws"', 'url = "ws://localhost:8080/ws"'),
            encoding="utf-8",
        )
        proc = subprocess.Popen(
            ["python", "-m", "mkui", "serve", target, "-p", "18795"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            cwd=target,
        )
        try:
            import time
            time.sleep(2)
        finally:
            proc.terminate()
            out, err = proc.communicate(timeout=5)
        self.assertIn("warning:", err)
        self.assertIn("port 8080, not 18795", err)

    def test_resolves_mkui_static_dir_placeholder(self):
        """The serve command resolves <mkui.static_dir> so mkio gets a real path."""
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        proc = subprocess.Popen(
            ["python", "-m", "mkui", "serve", target, "-p", "18791"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            cwd=target,
        )
        try:
            import time, urllib.request
            time.sleep(3)
            r = urllib.request.urlopen("http://localhost:18791/mkui/src/index.js")
            self.assertEqual(r.status, 200)
            self.assertIn("javascript", r.headers.get("Content-Type", ""))
        finally:
            proc.terminate()
            proc.wait(timeout=5)

    def test_serves_config_as_json(self):
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        proc = subprocess.Popen(
            ["python", "-m", "mkui", "serve", target, "-p", "18792"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            cwd=target,
        )
        try:
            import time, urllib.request
            time.sleep(3)
            r = urllib.request.urlopen("http://localhost:18792/config/client.json")
            self.assertEqual(r.status, 200)
            data = json.loads(r.read())
            self.assertIn("app", data)
            self.assertIn("panes", data)
        finally:
            proc.terminate()
            proc.wait(timeout=5)

    def test_serves_mkio_js(self):
        target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", target], capture_output=True)

        proc = subprocess.Popen(
            ["python", "-m", "mkui", "serve", target, "-p", "18793"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            cwd=target,
        )
        try:
            import time, urllib.request
            time.sleep(3)
            r = urllib.request.urlopen("http://localhost:18793/mkio.js")
            self.assertEqual(r.status, 200)
        finally:
            proc.terminate()
            proc.wait(timeout=5)

    def test_serve_help(self):
        r = subprocess.run(["python", "-m", "mkui", "serve", "--help"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        self.assertIn("--port", r.stdout)
        self.assertIn("--host", r.stdout)
        self.assertIn("--open", r.stdout)

    def test_command_help_says_what_it_does(self):
        from mkui.__main__ import MKIO_MAJOR
        # add_parser(help=) feeds only the parent's list; each command
        # needs its own description
        needles = {
            # every file init writes, its mkio dependency, and its refusal
            "init": ("server.toml", "config/client.toml", "static/index.html",
                     "mkio init", "already exists", "mkui serve"),
            # what serve needs, where it answers, and the port's real fallback
            "serve": ("server.toml", "mkui init", "http://localhost:", "8080",
                      "0.0.0.0", "/ws", f"mkio {MKIO_MAJOR}.x"),
        }
        for cmd, expected in needles.items():
            r = subprocess.run(["python", "-m", "mkui", cmd, "--help"], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0)
            self.assertEqual(r.stderr, "")
            for needle in expected:
                with self.subTest(cmd=cmd, needle=needle):
                    self.assertIn(needle, r.stdout)

    def test_top_level_help(self):
        r = subprocess.run(["python", "-m", "mkui", "--help"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        # the commands under their own heading, not argparse's `{init,serve}`
        self.assertIn("commands:", r.stdout)
        self.assertNotIn("{init,serve}", r.stdout)
        # the quick start keeps its line breaks (RawDescriptionHelpFormatter)
        self.assertIn("\n  mkui init myapp ", r.stdout)
        self.assertIn("\n  mkui serve myapp -o ", r.stdout)
        self.assertIn("mkui <command> -h", r.stdout)

    def test_help_names_the_port_serve_falls_back_to(self):
        # the help says 8080; cmd_serve must agree
        import inspect
        from mkui.__main__ import cmd_serve
        self.assertIn('config.get("port", 8080)', inspect.getsource(cmd_serve))

    def test_help_names_the_host_serve_falls_back_to(self):
        # the help says 0.0.0.0, mkio's own default; cmd_serve must agree
        import inspect
        from mkui.__main__ import cmd_serve
        self.assertIn('config.get("host", "0.0.0.0")', inspect.getsource(cmd_serve))


class TestServeAddress(unittest.TestCase):
    """Where `serve` says it is, and what it says about a client that
    would not find it there."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def project(self, url):
        root = Path(self.tmpdir)
        (root / "config").mkdir(exist_ok=True)
        (root / "config" / "client.toml").write_text(
            f'[mkio]\nurl = "{url}"\n' if url is not None else '[app]\ntitle = "x"\n',
            encoding="utf-8",
        )
        return root, {"config": {"/config": "./config"}}

    def test_every_interface_is_localhost_and_the_lan(self):
        from mkui.__main__ import serve_urls
        for host in ("0.0.0.0", "::", ""):
            self.assertEqual(
                serve_urls(host, 9000, lan=lambda: "192.168.1.20"),
                ("http://localhost:9000/", "http://192.168.1.20:9000/"),
            )
        self.assertEqual(serve_urls("0.0.0.0", 9000, lan=lambda: None), ("http://localhost:9000/", None))

    def test_one_address_is_the_only_one(self):
        from mkui.__main__ import serve_urls
        boom = lambda: self.fail("no LAN lookup for a named host")
        self.assertEqual(serve_urls("127.0.0.1", 8080, lan=boom), ("http://127.0.0.1:8080/", None))
        self.assertEqual(serve_urls("192.168.1.20", 8080, lan=boom), ("http://192.168.1.20:8080/", None))
        self.assertEqual(serve_urls("::1", 8080, lan=boom), ("http://[::1]:8080/", None))

    def test_lan_address_never_raises(self):
        from mkui.__main__ import lan_address
        addr = lan_address()
        self.assertTrue(addr is None or (isinstance(addr, str) and not addr.startswith("127.")))

    def test_a_client_dialing_another_port_is_warned_about(self):
        from mkui.__main__ import client_url_warnings
        for url in ("ws://localhost:8080/ws", "ws://127.0.0.1:8080/ws", "ws://[::1]:8080/ws", "ws://localhost/ws"):
            root, config = self.project(url)
            with self.subTest(url=url):
                got = client_url_warnings(root, config, "0.0.0.0", 9000)
                self.assertEqual(len(got), 1)
                self.assertIn(os.path.join("config", "client.toml"), got[0])
                self.assertIn("9000", got[0])
                self.assertIn('url = "/ws"', got[0])

    def test_the_bind_address_counts_as_this_server(self):
        from mkui.__main__ import client_url_warnings
        root, config = self.project("ws://192.168.1.20:8080/ws")
        self.assertEqual(len(client_url_warnings(root, config, "192.168.1.20", 9000)), 1)
        self.assertEqual(client_url_warnings(root, config, "0.0.0.0", 9000), [])

    def test_a_client_that_will_find_the_server_is_not(self):
        from mkui.__main__ import client_url_warnings
        for url in ("/ws", ":9000/ws", "ws://localhost:9000/ws", "wss://mkio.example.com/ws",
                    "ws://otherhost:8080/ws", "not a url", None):
            root, config = self.project(url)
            with self.subTest(url=url):
                self.assertEqual(client_url_warnings(root, config, "0.0.0.0", 9000), [])

    def test_no_config_route_no_warnings(self):
        from mkui.__main__ import client_url_warnings
        self.assertEqual(client_url_warnings(Path(self.tmpdir), {}, "0.0.0.0", 9000), [])
        self.assertEqual(
            client_url_warnings(Path(self.tmpdir), {"config": {"/config": "./missing"}}, "0.0.0.0", 9000), [])


class TestTemplateConsistency(unittest.TestCase):
    """Verify that the scaffold templates are internally consistent."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.target = os.path.join(self.tmpdir, "myapp")
        subprocess.run(["python", "-m", "mkui", "init", self.target], capture_output=True)

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_server_toml_has_mkio_services(self):
        """server.toml should have the services that client.toml references."""
        with open(os.path.join(self.target, "server.toml"), "rb") as f:
            server = tomllib.load(f)
        with open(os.path.join(self.target, "config", "client.toml"), "rb") as f:
            client = tomllib.load(f)

        services = set(server.get("services", {}).keys())
        for pane_id, pane in client.get("panes", {}).items():
            service = pane.get("service")
            if service:
                self.assertIn(service, services,
                    f"pane '{pane_id}' references service '{service}' not in server.toml")

    def test_client_toml_auth_method_matches_server_auth(self):
        """When auth is enabled, server should have auth tables (created by mkio init)."""
        with open(os.path.join(self.target, "server.toml"), "rb") as f:
            server = tomllib.load(f)
        with open(os.path.join(self.target, "config", "client.toml"), "rb") as f:
            client = tomllib.load(f)

        if client.get("auth", {}).get("method") == "mkio":
            tables = server.get("tables", {})
            self.assertIn("_mkio_users", tables)
            self.assertIn("_mkio_rights", tables)

    def test_client_toml_mkio_url_port_matches_server(self):
        """client.toml mkio.url port should match server.toml port."""
        with open(os.path.join(self.target, "server.toml"), "rb") as f:
            server = tomllib.load(f)
        with open(os.path.join(self.target, "config", "client.toml"), "rb") as f:
            client = tomllib.load(f)

        # Relative to the page, so it follows `serve -p`; a URL that does
        # name a port must name the server's.
        from urllib.parse import urlsplit
        ws_url = client.get("mkio", {}).get("url", "")
        self.assertEqual(ws_url, "/ws")
        named = urlsplit(ws_url).port
        if named is not None:
            self.assertEqual(named, server.get("port"))

    def test_client_pane_ids_match_frame_layouts(self):
        """Every pane referenced in frames.layout must exist in panes."""
        with open(os.path.join(self.target, "config", "client.toml"), "rb") as f:
            client = tomllib.load(f)

        pane_ids = set(client.get("panes", {}).keys())
        for frame in client.get("frames", []):
            layout = frame.get("layout", {})
            for child in layout.get("children", []):
                self.assertIn(child, pane_ids,
                    f"frame '{frame.get('id')}' references pane '{child}' not in panes")

    def test_server_toml_has_layout_store(self):
        """The Layout menu needs the mkui_layouts table and its three services,
        each locked to the caller's own rows when auth is on."""
        with open(os.path.join(self.target, "server.toml"), "rb") as f:
            server = tomllib.load(f)
        cols = server["tables"]["mkui_layouts"]["columns"]
        for col in ("id", "app", "owner", "saved", "layout"):
            self.assertIn(col, cols)
        self.assertNotIn("name", cols, "saves are unnamed")
        services = server["services"]
        txn = services["mkui_layouts"]
        self.assertEqual(txn["protocol"], "transaction")
        self.assertEqual(txn["ops"]["save"]["op_type"], "insert")
        self.assertEqual(txn["ops"]["save"]["fields"], ["app", "owner", "layout"])
        self.assertIn(":owner = :user", txn["ops"]["save"]["access"]["view"])
        self.assertEqual(txn["ops"]["delete"]["op_type"], "delete")
        self.assertIn("owner = :user", txn["ops"]["delete"]["access"]["view"])
        for name in ("mkui_layouts_list", "mkui_layouts_get"):
            self.assertEqual(services[name]["protocol"], "reqrep")
            self.assertIn("view", services[name]["access"])
            self.assertIn("mkui_layouts", services[name]["sql"])
        # The right the pre-checks hang off exists for every scaffolded role.
        rights = Path(self.target, "data", "rights.csv").read_text()
        self.assertIn("admin,view", rights)
        self.assertIn("user,view", rights)

    def test_client_toml_has_layout_menu(self):
        with open(os.path.join(self.target, "config", "client.toml"), "rb") as f:
            client = tomllib.load(f)
        self.assertIn("layouts", client)
        menus = [m for m in client["menubar"] if m.get("label") == "Layout"]
        self.assertEqual(len(menus), 1)
        items = menus[0]["items"]
        actions = {i.get("action") for i in items if "action" in i}
        self.assertEqual(actions, {"layout.save", "layout.reset"})
        markers = [i for i in items if i.get("layouts")]
        self.assertEqual(len(markers), 1)
        self.assertEqual(client["layouts"], {"keep": 10, "keepDays": 7})


if __name__ == "__main__":
    unittest.main()


class ExampleConfigsTest(unittest.TestCase):
    """Every shipped example config must be valid TOML (an inline table that
    spans lines is the classic slip) and declare the keys the docs promise."""

    def test_example_client_configs_parse(self):
        import glob
        import tomllib
        root = Path(__file__).resolve().parent.parent / "mkui" / "static" / "examples"
        paths = glob.glob(str(root / "*" / "config" / "client.toml"))
        self.assertTrue(paths)
        for p in paths:
            with open(p, "rb") as f:
                cfg = tomllib.load(f)
            self.assertIn("panes", cfg, p)

    def test_mkio_table_example_uses_expressions(self):
        import tomllib
        p = Path(__file__).resolve().parent.parent / "mkui" / "static" / "examples" / "mkio-table" / "config" / "client.toml"
        with open(p, "rb") as f:
            cfg = tomllib.load(f)
        pane = cfg["panes"]["all-orders"]
        self.assertEqual(pane["values"], {"notional": "ROUND(qty * price, 2)"})
        self.assertIn("when", pane["rowStyle"][0])
        self.assertEqual(cfg["mkio"]["expect"]["expr"], "2")

    def test_mkio_table_example_has_layout_store(self):
        import tomllib
        root = Path(__file__).resolve().parent.parent / "mkui" / "static" / "examples" / "mkio-table"
        with open(root / "config" / "client.toml", "rb") as f:
            client = tomllib.load(f)
        with open(root / "server.toml", "rb") as f:
            server = tomllib.load(f)
        self.assertIn("layouts", client)
        self.assertTrue(any(m.get("label") == "Layout" for m in client["menubar"]))
        self.assertIn("mkui_layouts", server["tables"])
        for name in ("mkui_layouts", "mkui_layouts_list", "mkui_layouts_get"):
            self.assertIn(name, server["services"])


class TestExampleConfigs(unittest.TestCase):
    """The shipped examples are documentation people run, so they have to
    parse and hang together. A multi-line inline table, or a pane naming a
    service the server never defines, is a broken example nobody notices
    until they try it."""

    EXAMPLES = Path(__file__).resolve().parent.parent / "mkui" / "static" / "examples"

    def _examples(self):
        for server in sorted(self.EXAMPLES.glob("*/server.toml")):
            yield server.parent

    def test_there_are_examples_to_check(self):
        self.assertGreaterEqual(len(list(self._examples())), 1)

    def test_configs_parse(self):
        # TOML inline tables must fit on one line; the parser is the judge.
        for ex in self._examples():
            with self.subTest(example=ex.name):
                with open(ex / "server.toml", "rb") as f:
                    tomllib.load(f)
                client = ex / "config" / "client.toml"
                if client.exists():
                    with open(client, "rb") as f:
                        tomllib.load(f)

    def test_panes_name_services_the_server_defines(self):
        for ex in self._examples():
            client = ex / "config" / "client.toml"
            if not client.exists():
                continue
            with self.subTest(example=ex.name):
                with open(ex / "server.toml", "rb") as f:
                    server = tomllib.load(f)
                with open(client, "rb") as f:
                    cfg = tomllib.load(f)
                services = set(server.get("services", {}))
                for pane_id, pane in cfg.get("panes", {}).items():
                    if pane.get("service"):
                        self.assertIn(pane["service"], services,
                                      f"{ex.name}: pane '{pane_id}'")
                    for key in ("versions", "state", "feed", "asOf"):
                        named = (pane.get("history") or {}).get(key)
                        if isinstance(named, str) and named:
                            self.assertIn(named, services,
                                          f"{ex.name}: {pane_id}.history.{key}")
                    for key in ("undo", "redo"):
                        step = (pane.get("history") or {}).get(key)
                        name = step.get("service") if isinstance(step, dict) else step
                        if isinstance(name, str) and name:
                            self.assertIn(name, services,
                                          f"{ex.name}: {pane_id}.history.{key}")

    def test_frames_name_panes_the_config_defines(self):
        for ex in self._examples():
            client = ex / "config" / "client.toml"
            if not client.exists():
                continue
            with self.subTest(example=ex.name):
                with open(client, "rb") as f:
                    cfg = tomllib.load(f)
                panes = set(cfg.get("panes", {}))

                def walk(node):
                    if isinstance(node, str):
                        self.assertIn(node, panes, f"{ex.name}: frame names '{node}'")
                    elif isinstance(node, dict):
                        for child in node.get("children", []):
                            walk(child)

                for frame in cfg.get("frames", []):
                    walk(frame.get("layout"))

    def test_history_blocks_name_a_versioned_table(self):
        for ex in self._examples():
            client = ex / "config" / "client.toml"
            if not client.exists():
                continue
            with self.subTest(example=ex.name):
                with open(ex / "server.toml", "rb") as f:
                    server = tomllib.load(f)
                with open(client, "rb") as f:
                    cfg = tomllib.load(f)
                versioned = {name for name, t in server.get("tables", {}).items()
                             if t.get("versioned")}
                for pane_id, pane in cfg.get("panes", {}).items():
                    table = (pane.get("history") or {}).get("table")
                    if table:
                        self.assertIn(table, versioned,
                                      f"{ex.name}: {pane_id}.history.table")

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
        self.assertIn("--open", r.stdout)


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

        ws_url = client.get("mkio", {}).get("url", "")
        server_port = server.get("port")
        if ws_url and server_port:
            self.assertIn(str(server_port), ws_url)

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


if __name__ == "__main__":
    unittest.main()

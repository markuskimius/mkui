"""The example apps' configs, checked against the servers they name.

`[mkio.expect]` is a promise about the server an example talks to, and a broken
promise is quiet: the client paints its `incompatible` map ("Wrong server") in
the statusbar rather than failing, which reads as a broken server instead of a
stale config. mkio 0.3 arriving beside an example that still said
`mkio = "0.2"` did exactly that — semver matching is exact-minor below 1.0, so
a minor release of the library invalidates the pin.

These tests put each example's own `expect` block through mkio's real
`InfoService`, the same code the browser's `_mkio` request reaches, so drift in
either repo fails here instead of in a statusbar. mkio is an optional
dependency of mkui, so they skip when it is not installed.
"""

import asyncio
import json
import time
import unittest
from pathlib import Path
from urllib.parse import urlparse

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib

try:
    from mkio.services.info import InfoService
except ModuleNotFoundError:  # pragma: no cover - mkio is optional
    InfoService = None

EXAMPLES = Path(__file__).resolve().parent.parent / "mkui" / "static" / "examples"

# The keys `_verify` sends and `InfoService` answers for. `name` is the one
# mkui checks itself, against the reply's `name`; the rest ride the request and
# come back in `compatibility`.
CHECKED_KEYS = {"name", "version", "protocol", "mkio", "expr"}


def load(path):
    return tomllib.loads(path.read_text())


def examples():
    """(name, server config, client config) for every example that has both."""
    out = []
    for d in sorted(p for p in EXAMPLES.iterdir() if p.is_dir()):
        server, client = d / "server.toml", d / "config" / "client.toml"
        if server.exists() and client.exists():
            out.append((d.name, load(server), load(client)))
    return out


def with_expect():
    return [e for e in examples() if e[2].get("mkio", {}).get("expect")]


class FakeWS:
    """Collects what a service sends, the way test_control.py's does."""

    def __init__(self):
        self.sent = []

    async def send_bytes(self, data):
        self.sent.append(json.loads(data))


def ask_mkio(server_config, expect):
    """Run one `_mkio` request against mkio's own InfoService.

    Returns the reply row — `name`/`version`/`protocol`/`mkio`/`expr` plus the
    `compatible` verdict and its per-key `compatibility` breakdown.
    """
    svc = InfoService(config={}, db=None, change_bus=None, writer=None)
    svc.name = "_mkio"
    svc._server_config = server_config
    svc._server_services = {}
    svc._started_ref = ""
    svc._started_monotonic = time.monotonic()

    # `name` never rides the request: mkui compares it to the reply itself.
    data = {k: str(v) for k, v in expect.items() if k != "name"}
    ws = FakeWS()
    asyncio.run(svc.on_message(ws, {"type": "request", "reqid": "1", "data": data}))

    assert len(ws.sent) == 1, f"expected one reply, got {ws.sent}"
    reply = ws.sent[0]
    assert reply.get("type") == "reply", f"not a reply: {reply}"
    return reply["row"]


@unittest.skipIf(InfoService is None, "mkio is not installed")
class TestExpect(unittest.TestCase):
    def test_at_least_one_example_declares_expect(self):
        """Guards the rest of this class against passing vacuously."""
        self.assertTrue(with_expect(), "no example declares [mkio.expect] any more")

    def test_every_expect_block_verifies_against_its_server(self):
        for name, server, client in with_expect():
            expect = client["mkio"]["expect"]
            with self.subTest(example=name):
                row = ask_mkio(server, expect)
                if "name" in expect:
                    self.assertEqual(
                        row["name"], expect["name"],
                        f"{name}: expect.name does not match server.toml's name",
                    )
                self.assertEqual(
                    row.get("compatibility"), {k: True for k in expect if k != "name"},
                    f"{name}: an expectation the server rejects — "
                    f"server says version={row['version']} protocol={row['protocol']} "
                    f"mkio={row['mkio']} expr={row['expr']}",
                )
                self.assertIs(row.get("compatible"), True, f"{name}: server reports incompatible")

    def test_expect_keys_are_ones_the_server_checks(self):
        """A key outside the set is not an error anywhere — it is just ignored."""
        for name, _server, client in with_expect():
            with self.subTest(example=name):
                unknown = set(client["mkio"]["expect"]) - CHECKED_KEYS
                self.assertEqual(unknown, set(), f"{name}: silently ignored expect keys")

    def test_a_stale_expectation_is_caught(self):
        """The negative control: prove the harness would notice a drifted pin.

        Without this, a change that stopped the compatibility check running
        would leave every assertion above trivially true.
        """
        for name, server, client in with_expect():
            expect = dict(client["mkio"]["expect"])
            with self.subTest(example=name):
                # Build the wrong pin from what the server actually reports,
                # not from the config, so the control holds however stale the
                # config happens to be.
                major, _, rest = ask_mkio(server, {})["mkio"].partition(".")
                minor = int(rest.split(".")[0] or 0)
                stale = {**expect, "mkio": f"{major}.{minor + 1}"}
                row = ask_mkio(server, stale)
                self.assertIs(row.get("compatible"), False, f"{name}: a wrong mkio pin passed")
                self.assertIs(row["compatibility"]["mkio"], False)

    def test_expect_version_tracks_the_server_it_names(self):
        """`version` is the app's own, so it must match that server.toml."""
        for name, server, client in with_expect():
            expect = client["mkio"]["expect"]
            with self.subTest(example=name):
                if "version" not in expect:
                    continue
                row = ask_mkio(server, expect)
                self.assertEqual(row["version"], server.get("version"))


@unittest.skipIf(InfoService is None, "mkio is not installed")
class TestClientServerWiring(unittest.TestCase):
    """The rest of the promises an example config makes about its server."""

    def test_mkio_url_points_at_its_own_server(self):
        for name, server, client in examples():
            url = client.get("mkio", {}).get("url")
            with self.subTest(example=name):
                if not url:
                    continue
                parsed = urlparse(url)
                self.assertEqual(
                    parsed.port, server.get("port"),
                    f"{name}: client connects to {parsed.port}, server listens on {server.get('port')}",
                )
                self.assertEqual(parsed.path, "/ws", f"{name}: mkio serves the socket at /ws")

    def test_control_names_the_service_serve_installs(self):
        from mkui.control import DEFAULT_NAME

        for name, _server, client in examples():
            control = client.get("mkio", {}).get("control")
            with self.subTest(example=name):
                if control is None:
                    continue
                self.assertEqual(
                    control, DEFAULT_NAME,
                    f"{name}: `mkui serve` installs the control service as {DEFAULT_NAME!r}",
                )


if __name__ == "__main__":
    unittest.main()

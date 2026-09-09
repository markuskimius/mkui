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

The same reasoning covers the rest of what a client config promises about its
server, which is the other half of this file: a pane naming a service that
server.toml does not define, a `history` block over a table that is not
`versioned`, an undo op that is not an undo, a menu action aimed at a pane that
does not exist, a frame listing a pane id nobody declared. None of those raise
anything — the pane sits empty, the button does nothing, the menu item is
inert — so they are caught by reading the two files against each other.
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


HISTORY_SUFFIX = "__history"

# Services `mkui serve` installs rather than server.toml declaring them.
INSTALLED_SERVICES = {"_mkio", "_mkui"}


def panes(client):
    return client.get("panes", {})


def menu_items(client):
    """Every leaf item of every menubar dropdown, submenus included."""
    out = []
    def walk(items):
        for it in items or []:
            if isinstance(it, dict):
                out.append(it)
                walk(it.get("items"))
    for menu in client.get("menubar", []) or []:
        walk(menu.get("items"))
    return out


def layout_panes(node):
    """The pane ids a frame's layout tree names, at any depth."""
    if isinstance(node, str):
        return [node]
    if not isinstance(node, dict):
        return []
    out = []
    for child in node.get("children", []) or []:
        out.extend(layout_panes(child))
    return out


def history_blocks(client):
    """(pane id, history block) for every pane that declares one."""
    return [(pid, spec["history"]) for pid, spec in panes(client).items()
            if isinstance(spec, dict) and isinstance(spec.get("history"), dict)]


def op_types(server, service, op):
    """The `op_type`s of a transaction service's named op, [] if absent."""
    ops = server.get("services", {}).get(service, {}).get("ops", {})
    return [step.get("op_type") for step in ops.get(op, []) if isinstance(step, dict)]


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


class TestPaneWiring(unittest.TestCase):
    """Every service, pane id, and table name a client config names.

    No mkio import: this reads the two TOML files against each other, so it
    runs whether or not the library is installed.
    """

    def test_at_least_one_example_has_panes(self):
        """Guards the rest of this class against passing vacuously."""
        self.assertTrue(
            [e for e in examples() if panes(e[2])],
            "no example declares panes any more",
        )

    def test_every_pane_service_is_declared_by_its_server(self):
        for name, server, client in examples():
            declared = set(server.get("services", {}))
            for pid, spec in panes(client).items():
                svc = spec.get("service") if isinstance(spec, dict) else None
                with self.subTest(example=name, pane=pid):
                    if svc is None:
                        continue
                    self.assertIn(
                        svc, declared,
                        f"{name}: pane {pid!r} subscribes to {svc!r}, "
                        f"which server.toml does not define",
                    )

    def test_every_frame_names_a_pane_that_exists(self):
        for name, _server, client in examples():
            known = set(panes(client))
            for frame in client.get("frames", []) or []:
                for pid in layout_panes(frame.get("layout")):
                    with self.subTest(example=name, frame=frame.get("id")):
                        self.assertIn(
                            pid, known,
                            f"{name}: frame {frame.get('id')!r} opens pane "
                            f"{pid!r}, which no [panes.*] declares",
                        )

    def test_every_menu_action_names_a_pane_that_exists(self):
        """`pane.show` takes the id as `args`; the table.* actions as `args.pane`."""
        seen = 0
        for name, _server, client in examples():
            known = set(panes(client))
            for item in menu_items(client):
                action, args = item.get("action"), item.get("args")
                target = None
                if action == "pane.show" and isinstance(args, str):
                    target = args
                elif isinstance(args, dict) and isinstance(args.get("pane"), str):
                    target = args["pane"]
                if target is None:
                    continue
                seen += 1
                with self.subTest(example=name, item=item.get("label")):
                    self.assertIn(
                        target, known,
                        f"{name}: menu item {item.get('label')!r} targets pane "
                        f"{target!r}, which no [panes.*] declares",
                    )
        self.assertTrue(seen, "no menu item targets a pane any more")

    def test_every_button_action_names_a_pane_that_exists(self):
        """A toolbar button's `type = "action"` args carry a pane id too."""
        for name, _server, client in examples():
            known = set(panes(client))
            for pid, spec in panes(client).items():
                for btn in (spec.get("buttons") if isinstance(spec, dict) else None) or []:
                    act = btn.get("action")
                    if not isinstance(act, dict) or act.get("type") != "action":
                        continue
                    args = act.get("args")
                    if not isinstance(args, dict) or not isinstance(args.get("pane"), str):
                        continue
                    with self.subTest(example=name, pane=pid, button=btn.get("label")):
                        self.assertIn(
                            args["pane"], known,
                            f"{name}: {pid}'s {btn.get('label')!r} button targets "
                            f"pane {args['pane']!r}, which no [panes.*] declares",
                        )

    def test_every_button_transaction_names_a_real_service_and_op(self):
        for name, server, client in examples():
            for pid, spec in panes(client).items():
                for btn in (spec.get("buttons") if isinstance(spec, dict) else None) or []:
                    act = btn.get("action")
                    if not isinstance(act, dict) or act.get("type") != "transaction":
                        continue
                    with self.subTest(example=name, pane=pid, button=btn.get("label")):
                        self.assertTrue(
                            op_types(server, act.get("service"), act.get("op")),
                            f"{name}: {pid}'s {btn.get('label')!r} button sends "
                            f"{act.get('op')!r} to {act.get('service')!r}, "
                            f"which server.toml does not define",
                        )


class TestHistoryWiring(unittest.TestCase):
    """A `history` block is the only thing that can say where a record's
    versions live — mkio advertises no history table and writes no service for
    one — so every name in it is an unchecked promise until here."""

    def test_at_least_one_example_declares_history(self):
        """Guards the rest of this class against passing vacuously."""
        found = [(n, pid) for n, _s, c in examples() for pid, _h in history_blocks(c)]
        self.assertTrue(found, "no example declares a [panes.*.history] block any more")

    def test_history_services_are_declared_by_the_server(self):
        """`versions`, `state`, `feed`, `asOf` — each a service name."""
        for name, server, client in examples():
            declared = set(server.get("services", {}))
            for pid, hist in history_blocks(client):
                for key in ("versions", "state", "feed", "asOf"):
                    svc = hist.get(key)
                    with self.subTest(example=name, pane=pid, key=key):
                        if not svc:
                            continue
                        self.assertIn(
                            svc, declared,
                            f"{name}: {pid}'s history.{key} names {svc!r}, "
                            f"which server.toml does not define",
                        )

    def test_history_table_is_versioned_on_the_server(self):
        """`table` is checked against the server's versioned tables at runtime;
        a mismatch only warns in the console, so it is caught here instead."""
        for name, server, client in examples():
            tables = server.get("tables", {})
            for pid, hist in history_blocks(client):
                table = hist.get("table")
                with self.subTest(example=name, pane=pid):
                    if not table:
                        continue
                    self.assertIn(table, tables, f"{name}: no [tables.{table}]")
                    self.assertIs(
                        tables[table].get("versioned"), True,
                        f"{name}: {pid}'s history is over {table!r}, which is "
                        f"not `versioned = true` — mkio records nothing for it",
                    )

    def test_history_key_columns_exist_on_the_table(self):
        for name, server, client in examples():
            tables = server.get("tables", {})
            for pid, hist in history_blocks(client):
                table, key = hist.get("table"), hist.get("key")
                with self.subTest(example=name, pane=pid):
                    if not table or not key or table not in tables:
                        continue
                    cols = set(tables[table].get("columns", {}))
                    missing = [k for k in key if k not in cols]
                    self.assertEqual(
                        missing, [],
                        f"{name}: {pid}'s history.key names {missing}, "
                        f"absent from [tables.{table}].columns",
                    )

    def test_undo_and_redo_name_ops_of_the_matching_op_type(self):
        """`{ service, op }`, where the op really is an undo (or a redo): an
        update named `undo` would step the record the wrong way, silently."""
        for name, server, client in examples():
            for pid, hist in history_blocks(client):
                for key in ("undo", "redo"):
                    step = hist.get(key)
                    with self.subTest(example=name, pane=pid, step=key):
                        if step is None:
                            continue
                        svc, op = (step, key) if isinstance(step, str) else (
                            step.get("service"), step.get("op"))
                        self.assertEqual(
                            op_types(server, svc, op), [key],
                            f"{name}: {pid}'s history.{key} is {svc}.{op}, which "
                            f"is not a single `op_type = \"{key}\"` step",
                        )

    def test_the_feed_reads_the_tables_history_table(self):
        """mkio's history table is the base name plus `__history`."""
        for name, server, client in examples():
            services = server.get("services", {})
            for pid, hist in history_blocks(client):
                feed, table = hist.get("feed"), hist.get("table")
                with self.subTest(example=name, pane=pid):
                    if not feed or not table or feed not in services:
                        continue
                    self.assertEqual(
                        services[feed].get("primary_table"), table + HISTORY_SUFFIX,
                        f"{name}: {pid}'s history.feed ({feed}) is not over "
                        f"{table + HISTORY_SUFFIX}",
                    )

    def test_a_pane_over_the_feed_reads_the_same_service(self):
        """An audit-tape pane is an ordinary table over the feed service; if it
        drifts off the feed the two views stop agreeing about the record."""
        for name, _server, client in examples():
            feeds = {h.get("feed") for _pid, h in history_blocks(client) if h.get("feed")}
            if not feeds:
                continue
            tapes = [pid for pid, spec in panes(client).items()
                     if isinstance(spec, dict) and spec.get("service") in feeds]
            with self.subTest(example=name):
                self.assertTrue(
                    tapes,
                    f"{name}: declares a history feed ({sorted(feeds)}) but no "
                    f"pane shows it",
                )

    def test_a_broken_history_promise_is_caught(self):
        """The negative control: prove the checks above are not vacuous."""
        for name, server, client in examples():
            if not history_blocks(client):
                continue
            with self.subTest(example=name):
                self.assertEqual(op_types(server, "orders", "nope"), [])
                declared = set(server.get("services", {}))
                self.assertNotIn("order_versions_typo", declared)
                pid, hist = history_blocks(client)[0]
                self.assertIn(hist.get("versions"), declared)


if __name__ == "__main__":
    unittest.main()

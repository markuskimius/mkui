"""The example apps' configs, checked against the servers they name.

`[mkio.expect]` is a promise about the server an example talks to, and a broken
promise is quiet: the client paints its `incompatible` map for reason
`version` in the statusbar rather than failing, which reads as a broken server
instead of a stale config. mkio 0.3 arriving beside an example that still said
`mkio = "0.2"` did exactly that. From mkio 1.0.0 the rule is semantic
versioning — a `mkio` pin accepts its own major at or above the pinned minor
and patch — so a pin goes stale only when it asks for a release newer than
the server, or when it still says `0.x`, which no 1.x server accepts.

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
import re
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
        would leave every assertion above trivially true. A pin one minor
        above the server asks for additions it does not have, under the
        exact-minor rule of 0.x and the semantic rule of 1.x alike.
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

    def test_a_pre_1_0_pin_is_rejected_by_a_1x_server(self):
        """The hazard of mkio's 1.0.0: `mkio = "0.x"` was the exact-minor
        pin every pre-1.0 example carried, and a 1.x server accepts none of
        them — the statusbar would read "incompatible" against a server that
        is nothing but newer."""
        for name, server, client in with_expect():
            expect = dict(client["mkio"]["expect"])
            with self.subTest(example=name):
                served = ask_mkio(server, {})["mkio"]
                self.assertRegex(served, r"^[1-9]\d*\.", f"the installed mkio is {served}, not 1.x+")
                row = ask_mkio(server, {**expect, "mkio": "0.10"})
                self.assertIs(row.get("compatible"), False, f"{name}: a 0.x pin passed a 1.x server")
                self.assertIs(row["compatibility"]["mkio"], False)

    def test_no_example_pins_mkio_below_1(self):
        """mkui 1.x is built against mkio 1.x and checks the major itself
        (`lib/verify.js`); a `0.x` pin in an example would be the stale one
        the test above rejects."""
        for name, _server, client in with_expect():
            pin = client["mkio"]["expect"].get("mkio")
            with self.subTest(example=name):
                if pin is None:
                    continue
                self.assertRegex(str(pin), r"^[1-9]", f"{name}: expect.mkio = {pin!r} is pre-1.0")

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
                # Relative to the page (`lib/mkio-url.js`), so `mkui serve
                # -p` moves the socket with it; a URL that does name a port
                # must name the server's.
                self.assertEqual(parsed.netloc, "", f"{name}: mkio.url should follow the page, not name a host")
                if parsed.port is not None:
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


SRC = Path(__file__).resolve().parent.parent / "mkui" / "static" / "src"

# `app.quit` is the one action `fireAction` handles itself (core.js); every
# other built-in is registered by name, so the source is the list.
QUIT = "app.quit"


def registered_actions(root):
    """Every name passed to `registerAction("<name>", …)` under a JS tree."""
    names = set()
    for path in sorted(root.rglob("*.js")):
        names |= set(re.findall(r'registerAction\(\s*"([^"]+)"', path.read_text()))
    return names


BUILTIN_ACTIONS = registered_actions(SRC) | {QUIT}


def example_actions(name):
    """Built-ins plus whatever this example's own JS registers."""
    return BUILTIN_ACTIONS | registered_actions(EXAMPLES / name / "static")


def menus(client):
    return client.get("menubar", []) or []


def button_actions(client):
    """(pane id, button, action name) for every `type = "action"` button."""
    out = []
    for pid, spec in panes(client).items():
        for btn in (spec.get("buttons") if isinstance(spec, dict) else None) or []:
            act = btn.get("action")
            if isinstance(act, dict) and act.get("type") == "action":
                out.append((pid, btn, act.get("name")))
    return out


def opened_panes(client):
    """The panes the config's frames open at startup."""
    out = set()
    for frame in client.get("frames", []) or []:
        out |= set(layout_panes(frame.get("layout")))
    return out


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

    def test_unversioned_columns_are_declared_and_not_key(self):
        """`unversioned` (mkio 0.6) names columns the history leaves out: each
        must be a declared column, never a key column (mkio refuses that at
        load, but the client's `history.key` is checked here), and one
        example shows the feature so the panes' handling of it is exercised."""
        shown = []
        for name, server, client in examples():
            tables = server.get("tables", {})
            for pid, hist in history_blocks(client):
                table = hist.get("table")
                if not table or table not in tables:
                    continue
                unv = tables[table].get("unversioned") or []
                with self.subTest(example=name, pane=pid):
                    cols = set(tables[table].get("columns", {}))
                    self.assertEqual([c for c in unv if c not in cols], [],
                                     f"{name}: unversioned names a column [tables.{table}] lacks")
                    self.assertEqual([c for c in unv if c in (hist.get("key") or [])], [],
                                     f"{name}: {pid}'s history.key overlaps unversioned")
                    if unv:
                        shown.append((name, table, unv))
        self.assertTrue(shown, "no example declares an `unversioned` column any more")

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



class TestMenubarWiring(unittest.TestCase):
    """What a menu item promises about the app behind it.

    A menubar fails quietly in exactly the way the rest of this file is about:
    `fireAction` warns to a console nobody is reading and the item does
    nothing, so a renamed action, a `layout.*` item in an app with no
    `[layouts]` block, or a pane that no menu can reach all look like a menu
    that is simply broken. Reading the config against the source that
    registers the actions catches them here instead.
    """

    def test_at_least_one_example_has_a_menubar(self):
        """Guards the rest of this class against passing vacuously."""
        self.assertTrue(
            [e for e in examples() if menus(e[2])],
            "no example declares a menubar any more",
        )

    def test_the_builtin_action_list_was_actually_found(self):
        """The negative control for the scrape: it is a regex over the source."""
        for name in ("pane.show", "window.grid", "edit.copy", "table.history"):
            self.assertIn(name, BUILTIN_ACTIONS, f"{name!r} is no longer registered")
        self.assertNotIn("table.nope", BUILTIN_ACTIONS)

    def test_every_menu_action_is_one_the_app_registers(self):
        seen = 0
        for name, _server, client in examples():
            known = example_actions(name)
            for item in menu_items(client):
                action = item.get("action")
                if action is None:
                    continue
                seen += 1
                with self.subTest(example=name, item=item.get("label")):
                    self.assertIn(
                        action, known,
                        f"{name}: menu item {item.get('label')!r} fires "
                        f"{action!r}, which nothing registers",
                    )
        self.assertTrue(seen, "no menu item fires an action any more")

    def test_every_button_action_is_one_the_app_registers(self):
        for name, _server, client in examples():
            known = example_actions(name)
            for pid, btn, action in button_actions(client):
                with self.subTest(example=name, pane=pid, button=btn.get("label")):
                    self.assertIn(
                        action, known,
                        f"{name}: {pid}'s {btn.get('label')!r} button fires "
                        f"{action!r}, which nothing registers",
                    )

    def test_layout_items_require_a_layouts_block(self):
        """`layout.*` and `layouts = true` are inert without `[layouts]`."""
        for name, _server, client in examples():
            has_layouts = bool(client.get("layouts"))
            for item in menu_items(client):
                wants = (item.get("action") or "").startswith("layout.") or item.get("layouts")
                if not wants:
                    continue
                with self.subTest(example=name, item=item.get("label")):
                    self.assertTrue(
                        has_layouts,
                        f"{name}: menu item {item.get('label')!r} saves or "
                        f"restores layouts, but the config has no [layouts] block",
                    )

    def test_an_expanding_item_carries_nothing_of_its_own(self):
        """`windows` / `layouts` items are replaced wholesale when the menu
        opens, so an `action` or `items` on one is silently dropped."""
        seen = 0
        for name, _server, client in examples():
            for item in menu_items(client):
                kinds = [k for k in ("windows", "layouts") if item.get(k)]
                if not kinds:
                    continue
                seen += 1
                with self.subTest(example=name, item=item.get("label"), kind=kinds[0]):
                    self.assertEqual(len(kinds), 1, "an item expands one way")
                    self.assertIsNone(
                        item.get("action"),
                        f"{name}: {kinds[0]} item also names an action",
                    )
                    self.assertIsNone(
                        item.get("items"),
                        f"{name}: {kinds[0]} item also names its own submenu",
                    )
        self.assertTrue(seen, "no menu item expands any more")

    def test_every_menubar_lists_the_open_panes(self):
        """A frame raised behind another, or a pane sharing a frame's tab bar,
        is reachable only through the `windows = true` expansion."""
        for name, _server, client in examples():
            with self.subTest(example=name):
                self.assertTrue(
                    any(it.get("windows") for it in menu_items(client)),
                    f"{name}: no menu expands into the open panes "
                    f"({{ windows = true }}), so a buried pane cannot be raised",
                )

    def test_a_parked_pane_has_a_menu_item_of_its_own(self):
        """`windows = true` lists *open* panes, so one no frame opens needs an
        explicit `pane.show` or nothing can ever open it."""
        for name, _server, client in examples():
            shown = {
                it.get("args") for it in menu_items(client)
                if it.get("action") == "pane.show" and isinstance(it.get("args"), str)
            }
            # A history pane is opened by `table.history`, not by id.
            for pid in sorted(set(panes(client)) - opened_panes(client)):
                with self.subTest(example=name, pane=pid):
                    self.assertIn(
                        pid, shown,
                        f"{name}: pane {pid!r} is in no frame and in no menu, "
                        f"so nothing can open it",
                    )

    def test_menu_labels_are_unique(self):
        """Two dropdowns with one name is a config mistake, not a feature."""
        for name, _server, client in examples():
            labels = [m.get("label") for m in menus(client)]
            with self.subTest(example=name):
                self.assertEqual(
                    len(labels), len(set(labels)),
                    f"{name}: duplicate menubar labels {labels}",
                )
                self.assertTrue(all(labels), f"{name}: a menu has no label")


if __name__ == "__main__":
    unittest.main()

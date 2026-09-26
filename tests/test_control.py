"""Tests for mkui.control — the ControlService that pushes actions to browsers."""

import asyncio
import json
import unittest

from mkui.control import ControlService, install


class FakeWS:
    def __init__(self, user=None, fail=False):
        self.sent = []
        self.fail = fail
        if user is not None:
            self._mkio_auth = {"user": user, "role": "viewer"}

    async def send_bytes(self, data):
        if self.fail:
            raise ConnectionError("gone")
        self.sent.append(json.loads(data))


def run(coro):
    return asyncio.run(coro)


def make():
    return ControlService({}, db=None, change_bus=None, writer=None)


class TestControlService(unittest.TestCase):
    def test_defaults_speak_subpub_gated_by_auth(self):
        svc = make()
        self.assertEqual(svc.config, {"protocol": "subpub", "access": "auth"})
        svc2 = ControlService({"access": "open"}, None, None, None)
        self.assertEqual(svc2.config["access"], "open")
        self.assertEqual(svc2.config["protocol"], "subpub")

    def test_subscribe_answers_an_empty_snapshot_and_counts(self):
        svc = make()
        svc.name = "_mkui"
        ws = FakeWS(user="mark")
        n = run(svc.on_subscribe(ws, {"type": "subscribe", "subid": "mkui-control", "topic": "mkui"}))
        self.assertEqual(n, 1)
        self.assertEqual(ws.sent, [{"type": "snapshot", "service": "_mkui", "rows": [], "hasmore": False, "subid": "mkui-control"}])
        self.assertEqual(svc.subscribers, 1)
        self.assertEqual(svc.users(), ["mark"])

    def test_send_reaches_every_tab_or_one_user(self):
        svc = make()
        svc.name = "_mkui"
        a, b, anon = FakeWS(user="mark"), FakeWS(user="pat"), FakeWS()
        for ws in (a, b, anon):
            run(svc.on_subscribe(ws, {"subid": "s"}))
            ws.sent.clear()
        self.assertEqual(run(svc.send("pane.show", "orders")), 3)
        self.assertEqual(a.sent, [{"type": "update", "service": "_mkui", "op": "action", "row": {"action": "pane.show", "args": "orders"}, "subid": "s"}])
        self.assertEqual(run(svc.send("edit.find", user="pat")), 1)
        self.assertEqual(len(a.sent), 1)
        self.assertEqual(b.sent[-1]["row"], {"action": "edit.find"}, "no args key when there are none")
        self.assertEqual(run(svc.send("x", user="")), 1, "the empty user is the anonymous tabs")
        self.assertEqual(anon.sent[-1]["row"]["action"], "x")
        self.assertEqual(svc.users(), ["mark", "pat", ""])

    def test_send_rejects_a_bad_action_and_drops_dead_sockets(self):
        svc = make()
        svc.name = "_mkui"
        with self.assertRaises(ValueError):
            run(svc.send(""))
        dead, live = FakeWS(), FakeWS()
        run(svc.on_subscribe(dead, {}))
        run(svc.on_subscribe(live, {}))
        dead.fail = True
        self.assertEqual(run(svc.send("a")), 1)
        self.assertEqual(svc.subscribers, 1, "the failed socket is forgotten")

    def test_unsubscribe_by_socket_or_by_subid(self):
        svc = make()
        ws = FakeWS()
        run(svc.on_subscribe(ws, {"subid": "one"}))
        run(svc.on_subscribe(ws, {"subid": "two"}))
        self.assertEqual(run(svc.on_unsubscribe(ws, {"subid": "one"})), 1)
        self.assertEqual(svc.subscribers, 1)
        # A disconnect unsubscribes without a subid: everything of that socket goes.
        self.assertEqual(run(svc.on_unsubscribe(ws, {"type": "unsubscribe", "service": "_mkui"})), 1)
        self.assertEqual(svc.subscribers, 0)

    def test_link_builds_the_table_link_action(self):
        svc = make()
        svc.name = "_mkui"
        ws = FakeWS()
        run(svc.on_subscribe(ws, {"subid": "s"}))
        ws.sent.clear()
        run(svc.link("execs", listen={"order_id": "parent_id"}, broadcast={"exec_id": "id"}, listening=False))
        self.assertEqual(ws.sent[-1]["row"], {
            "action": "table.link",
            "args": {"merge": True, "pane": "execs", "link": {"listen": {"order_id": "parent_id"}, "broadcast": {"exec_id": "id"}, "listening": False}},
        })
        run(svc.link(None, merge=False))
        self.assertEqual(ws.sent[-1]["row"]["args"], {"merge": False, "link": {}}, "no pane: the focused one; merge off with nothing: clears")

    def test_frame_shows_a_configured_window(self):
        svc = make()
        svc.name = "_mkui"
        ws = FakeWS(user="ann")
        run(svc.on_subscribe(ws, {"subid": "s"}))
        ws.sent.clear()
        self.assertEqual(run(svc.frame("desk")), 1)
        self.assertEqual(ws.sent[-1]["row"], {"action": "frame.show", "args": "desk"})
        self.assertEqual(run(svc.frame("desk", user="bob")), 0, "another login's tabs only")
        with self.assertRaises(ValueError):
            run(svc.frame(""))

    def test_record_shows_one_record_or_says_where_to_get_them(self):
        svc = make()
        svc.name = "_mkui"
        ws = FakeWS()
        run(svc.on_subscribe(ws, {"subid": "s"}))
        ws.sent.clear()

        run(svc.record("detail", {"id": 4711}))
        self.assertEqual(ws.sent[-1]["row"], {
            "action": "record.show",
            "args": {"key": {"id": 4711}, "pane": "detail"},
        })

        run(svc.record("detail", listen={"order_id": "id"}, retain=True))
        self.assertEqual(ws.sent[-1]["row"], {
            "action": "record.follow",
            "args": {"merge": True, "pane": "detail",
                     "record": {"listen": {"order_id": "id"}, "retain": True}},
        })

        # The pin is the user-facing word; `listening` is the switch.
        run(svc.record("detail", pin=True))
        self.assertEqual(ws.sent[-1]["row"]["args"]["record"], {"listening": False})

        run(svc.record(None, follow="orders", merge=False))
        self.assertEqual(ws.sent[-1]["row"]["args"],
                         {"merge": False, "record": {"follow": "orders"}},
                         "no pane: the focused one")

    def test_alert_builds_the_dialog_alert_action(self):
        svc = make()
        svc.name = "_mkui"
        ws = FakeWS(user="mark")
        run(svc.on_subscribe(ws, {"subid": "s"}))
        ws.sent.clear()
        self.assertEqual(run(svc.alert("Saved.")), 1)
        self.assertEqual(ws.sent[-1]["row"], {"action": "dialog.alert", "args": {"message": "Saved."}},
                         "only what was given rides the wire")
        run(svc.alert(["Market closes in 5 minutes", "Day orders will be cancelled."], title="Close", kind="warn",
                      details={"label": "Orders", "text": "#1, #2"}, timeout=30, id="close", suppress="close.notice"))
        self.assertEqual(ws.sent[-1]["row"]["args"], {
            "message": ["Market closes in 5 minutes", "Day orders will be cancelled."],
            "title": "Close", "kind": "warn", "details": {"label": "Orders", "text": "#1, #2"},
            "timeout": 30, "id": "close", "suppress": "close.notice",
        })
        self.assertEqual(run(svc.alert("x", user="nobody")), 0)
        for bad in ("", None, 7, []):
            with self.assertRaises(ValueError):
                run(svc.alert(bad))

    def test_confirm_carries_what_the_answer_does(self):
        svc = make()
        svc.name = "_mkui"
        ws = FakeWS(user="ann")
        run(svc.on_subscribe(ws, {"subid": "s"}))
        ws.sent.clear()
        submit = {"service": "orders", "op": "roll", "data": {"desk": "fx"}}
        run(svc.confirm("Roll your day orders?", ok="Roll", cancel="Not now", submit=submit, kind="danger",
                        arm=2, modal=False, id="roll", then={"action": "pane.show", "args": "orders"}, user="ann"))
        self.assertEqual(ws.sent[-1]["row"], {"action": "dialog.confirm", "args": {
            "message": "Roll your day orders?", "kind": "danger", "id": "roll", "ok": "Roll", "cancel": "Not now",
            "arm": 2, "modal": False, "submit": submit, "then": {"action": "pane.show", "args": "orders"},
        }})
        run(svc.confirm("Sure?"))
        self.assertEqual(ws.sent[-1]["row"]["args"], {"message": "Sure?"})

    def test_dialog_opens_a_named_one_or_a_whole_spec(self):
        svc = make()
        svc.name = "_mkui"
        ws = FakeWS()
        run(svc.on_subscribe(ws, {"subid": "s"}))
        ws.sent.clear()
        run(svc.dialog("new-order"))
        self.assertEqual(ws.sent[-1]["row"], {"action": "dialog.open", "args": {"dialog": "new-order"}})
        spec = {"message": "Pick one", "buttons": [{"label": "A", "submit": {"service": "votes", "data": {"v": "a"}}}]}
        run(svc.dialog(spec, context={"poll": 7}))
        self.assertEqual(ws.sent[-1]["row"]["args"], {"dialog": spec, "context": {"poll": 7}})

    def test_install_registers_and_binds_late(self):
        calls = []

        class App:
            services = {}

            def add_service(self, name, cls, config=None):
                calls.append((name, cls, config))

        app = App()
        handle = install(app)
        self.assertEqual(calls, [("_mkui", ControlService, None)])
        with self.assertRaisesRegex(RuntimeError, "not running yet"):
            handle.subscribers
        svc = make()
        svc.name = "_mkui"
        app.services["_mkui"] = svc
        self.assertEqual(handle.subscribers, 0)
        self.assertEqual(run(handle.send("a")), 0)


if __name__ == "__main__":
    unittest.main()

"""The control channel: drive a running mkui app from Python.

A :class:`ControlService` is an mkio service the browser subscribes to
(``mkio.control = "_mkui"`` in the client config). Whatever it pushes is
an *action* — the same ``table.link``, ``table.filter``, ``pane.show`` …
actions a menu item fires, or any the app registered — so a Python
process that embeds mkio can rewire tables while people are looking at
them::

    from mkio import create_app
    from mkui.control import install

    app = create_app("server.toml")
    control = install(app)          # app.add_service("_mkui", ControlService)

    async def on_started():
        await control.link("executions", listen={"order_id": "parent_order_id"})
        await control.link("orders", broadcast={"order_id": "id"})
        await control.record("order_detail", listen={"order_id": "id"})
        await control.send("table.filter", {"pane": "orders", "filters": {"status": ["open"]}})
        await control.alert("Market closes in 5 minutes", kind="warn", id="close")

    app.on_startup(on_started)
    app.run()

Each browser tab is one subscriber; :meth:`ControlService.send` reaches
every one, or only the tabs a given login holds (``user=``). Nothing is
queued for tabs that connect later — push after they subscribe (an
``on_connect`` hook, or the next time your own state changes).

The service speaks mkio's subpub protocol on the wire, so it needs no
table: a subscribe gets an empty snapshot, and every push is an
``update`` whose row is ``{"action": name, "args": …}``.

Built on mkio 1.x: :class:`mkio.services.base.Service` and the envelope
builders in :mod:`mkio.ws_protocol` are part of what mkio's semantic
versioning promises, so any 1.x release serves this module unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, TYPE_CHECKING

from mkio.services.base import Service
from mkio.ws_protocol import make_snapshot, make_update

if TYPE_CHECKING:
    from aiohttp.web import WebSocketResponse

__all__ = ["ControlService", "install"]

DEFAULT_NAME = "_mkui"


@dataclass
class _Subscriber:
    ws: Any
    subid: str | None
    user: str | None


class ControlService(Service):
    """Push actions to subscribed mkui browsers.

    Register with ``app.add_service(name, ControlService, config)``.
    ``config`` defaults to ``{"protocol": "subpub", "access": "auth"}``:
    subpub is what the browser subscribes with, and ``access`` gates the
    subscription under mkio auth (``"open"`` lets anyone listen; a right
    name or map works as for any service). Without auth the check is
    skipped.
    """

    def __init__(self, config: dict[str, Any], db: Any, change_bus: Any, writer: Any) -> None:
        cfg = {"protocol": "subpub", "access": "auth"}
        cfg.update(config or {})
        super().__init__(cfg, db, change_bus, writer)
        self._subs: list[_Subscriber] = []

    # ── mkio service hooks ──────────────────────────────────────────

    async def on_subscribe(self, ws: WebSocketResponse, msg: dict[str, Any]) -> int:
        subid = msg.get("subid")
        auth = getattr(ws, "_mkio_auth", None)
        user = auth.get("user") if isinstance(auth, dict) else None
        self._subs.append(_Subscriber(ws=ws, subid=subid, user=user))
        resp = make_snapshot(None, self.name, [], subid=subid)
        await ws.send_bytes(resp)
        await self.notify_monitors("out", resp)
        return 1

    async def on_unsubscribe(self, ws: WebSocketResponse, msg: dict[str, Any]) -> int:
        subid = msg.get("subid")
        before = len(self._subs)
        self._subs = [
            s for s in self._subs
            if not (s.ws is ws and (subid is None or s.subid == subid))
        ]
        return before - len(self._subs)

    # ── the Python side ─────────────────────────────────────────────

    @property
    def subscribers(self) -> int:
        """How many browser subscriptions are live."""
        return len(self._subs)

    def users(self) -> list[str]:
        """The distinct logins currently subscribed (``""`` for anonymous)."""
        seen: list[str] = []
        for s in self._subs:
            u = s.user or ""
            if u not in seen:
                seen.append(u)
        return seen

    async def send(self, action: str, args: Any = None, *, user: str | None = None) -> int:
        """Fire ``action`` (with ``args``) in every subscribed browser, or
        only in the tabs of ``user``. Returns the number of tabs reached; a
        tab whose socket fails is dropped.
        """
        if not isinstance(action, str) or not action:
            raise ValueError("action must be a non-empty string")
        row: dict[str, Any] = {"action": action}
        if args is not None:
            row["args"] = args
        sent = 0
        for s in list(self._subs):
            if user is not None and (s.user or "") != user:
                continue
            payload = make_update(self.name, None, "action", row, subid=s.subid)
            try:
                await s.ws.send_bytes(payload)
            except Exception:
                self._subs.remove(s)
                continue
            await self.notify_monitors("out", payload)
            sent += 1
        return sent

    async def link(
        self,
        pane: str | None,
        *,
        broadcast: dict[str, str] | None = None,
        listen: dict[str, Any] | None = None,
        broadcasting: bool | None = None,
        listening: bool | None = None,
        merge: bool = True,
        user: str | None = None,
    ) -> int:
        """Configure a table's links — the ``table.link`` action.

        ``broadcast`` maps names to the pane's columns; ``listen`` maps
        names to a column (or ``{"column", "scope"}``); ``broadcasting`` /
        ``listening`` pause or resume a direction. With ``merge`` (the
        default) only the keys given change — a ``None`` name entry drops
        that name; ``merge=False`` replaces the whole configuration, so
        ``link(pane, merge=False)`` clears it. ``pane=None`` targets the
        focused pane.
        """
        args: dict[str, Any] = {"merge": merge}
        if pane is not None:
            args["pane"] = pane
        link: dict[str, Any] = {}
        if broadcast is not None:
            link["broadcast"] = broadcast
        if listen is not None:
            link["listen"] = listen
        if broadcasting is not None:
            link["broadcasting"] = broadcasting
        if listening is not None:
            link["listening"] = listening
        args["link"] = link
        return await self.send("table.link", args, user=user)

    async def record(
        self,
        pane: str | None,
        key: dict[str, Any] | None = None,
        *,
        listen: dict[str, Any] | None = None,
        follow: str | None = None,
        state: str | None = None,
        pin: bool | None = None,
        retain: bool | None = None,
        title: str | None = None,
        merge: bool = True,
        user: str | None = None,
    ) -> int:
        """Drive a detail window — ``mkio-record``, ``mkio-history``, or any
        pane an application built on ``attachRecord``.

        With ``key`` it fires ``record.show``: that record, now::

            await control.record("order_detail", {"id": 4711})

        Otherwise it fires ``record.follow``, saying where the window gets
        its records — ``listen`` (a map of broadcast name to key column,
        putting the window on the link hub), ``follow`` (a pane whose
        selection it tracks), or ``state`` (a state path a row is
        published to). ``pin=True`` freezes the window on the record it
        holds, ``retain`` keeps the last record when the source clears,
        and ``title`` is the template naming its tab. Under ``merge`` (the
        default) only what is given changes. ``pane=None`` targets the
        focused pane.
        """
        if key is not None:
            args: dict[str, Any] = {"key": key}
            if pane is not None:
                args["pane"] = pane
            return await self.send("record.show", args, user=user)

        args = {"merge": merge}
        if pane is not None:
            args["pane"] = pane
        record: dict[str, Any] = {}
        if listen is not None:
            record["listen"] = listen
        if follow is not None:
            record["follow"] = follow
        if state is not None:
            record["state"] = state
        if retain is not None:
            record["retain"] = retain
        if pin is not None:
            record["listening"] = not pin
        if title is not None:
            record["title"] = title
        args["record"] = record
        return await self.send("record.follow", args, user=user)


    # ── message boxes ───────────────────────────────────────────────

    async def alert(
        self,
        message: str | list[str],
        *,
        title: str | None = None,
        kind: str | None = None,
        details: str | dict[str, Any] | None = None,
        timeout: float | None = None,
        id: str | None = None,
        suppress: str | dict[str, Any] | None = None,
        user: str | None = None,
    ) -> int:
        """Put a notice on screen — the ``dialog.alert`` action.

        ``message`` is a string or a list of paragraphs; ``kind`` is
        ``info`` (the default), ``success``, ``warn`` or ``danger``.
        ``details`` folds a long part under it, ``timeout`` closes it after
        that many seconds unless someone touches it, and ``suppress`` adds
        a "Don't show this again" box under that key. Give a notice you may
        push again an ``id``: a second one replaces the first where it
        stands instead of stacking on it::

            await control.alert("Reconnecting to the exchange…", kind="warn", id="exch")
        """
        args = _message_args(message, title=title, kind=kind, details=details,
                             timeout=timeout, id=id, suppress=suppress)
        return await self.send("dialog.alert", args, user=user)

    async def confirm(
        self,
        message: str | list[str],
        *,
        submit: dict[str, Any] | None = None,
        then: dict[str, Any] | None = None,
        title: str | None = None,
        kind: str | None = None,
        ok: str | None = None,
        cancel: str | None = None,
        arm: float | None = None,
        details: str | dict[str, Any] | None = None,
        timeout: float | None = None,
        id: str | None = None,
        modal: bool | None = None,
        user: str | None = None,
    ) -> int:
        """Ask a question — the ``dialog.confirm`` action.

        A push has no reply, so the answer comes back the way everything
        else reaches the server: ``submit = {"service", "op", "data"}`` is
        the transaction the OK button sends (the box stays open, saying
        why, if it is refused), so the answer is a row the server wrote::

            await control.confirm(
                "Roll your 3 day orders to tomorrow?", ok="Roll",
                submit={"service": "orders", "op": "roll", "data": {"desk": "fx"}},
                user="ann", id="roll")

        ``then = {"action", "args"}`` fires an mkui action in that browser
        on OK instead (or as well). Cancelling sends and fires nothing.
        ``kind="danger"`` makes OK a red button that is never the default,
        ``arm`` keeps it shut for that many seconds; ``modal=False`` lets
        the workspace stay usable under the question.
        """
        args = _message_args(message, title=title, kind=kind, details=details,
                             timeout=timeout, id=id, ok=ok, cancel=cancel, arm=arm,
                             modal=modal, submit=submit, then=then)
        return await self.send("dialog.confirm", args, user=user)

    async def dialog(
        self,
        dialog: str | dict[str, Any],
        *,
        context: dict[str, Any] | None = None,
        user: str | None = None,
    ) -> int:
        """Open a dialog — the ``dialog.open`` action: the name of one under
        the client config's ``dialogs``, or a whole spec (a form, or with
        ``message`` and ``buttons`` a message box whose buttons each carry
        their own ``submit``). ``context`` is what its templates see beside
        ``state`` and ``app``.
        """
        args: dict[str, Any] = {"dialog": dialog}
        if context is not None:
            args["context"] = context
        return await self.send("dialog.open", args, user=user)


def _message_args(message: Any, **keys: Any) -> dict[str, Any]:
    if not isinstance(message, (str, list)) or not message:
        raise ValueError("message must be a non-empty string or list of strings")
    args: dict[str, Any] = {"message": message}
    args.update({k: v for k, v in keys.items() if v is not None})
    return args


def install(app: Any, name: str = DEFAULT_NAME, config: dict[str, Any] | None = None) -> ControlService:
    """Register a :class:`ControlService` on an ``MkioApp`` before it starts
    and return a handle that resolves to the live instance once it has.

    ``add_service`` only records the class; the instance exists after
    ``start()``. The returned proxy forwards ``send`` / ``link`` / the
    rest to ``app.services[name]`` at call time, so it can be created up
    front and used from an ``on_startup`` hook.
    """
    app.add_service(name, ControlService, config)
    return _Handle(app, name)  # type: ignore[return-value]


class _Handle:
    """Late-binding proxy to the service instance ``app.services[name]``."""

    def __init__(self, app: Any, name: str) -> None:
        self._app = app
        self._name = name

    def _svc(self) -> ControlService:
        svc = (getattr(self._app, "services", None) or {}).get(self._name)
        if svc is None:
            raise RuntimeError(f"control service '{self._name}' is not running yet — call after app.start()")
        return svc

    def __getattr__(self, attr: str) -> Any:
        return getattr(self._svc(), attr)

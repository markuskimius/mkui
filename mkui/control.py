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
        await control.send("table.filter", {"pane": "orders", "filters": {"status": ["open"]}})

    app.on_startup(on_started)
    app.run()

Each browser tab is one subscriber; :meth:`ControlService.send` reaches
every one, or only the tabs a given login holds (``user=``). Nothing is
queued for tabs that connect later — push after they subscribe (an
``on_connect`` hook, or the next time your own state changes).

The service speaks mkio's subpub protocol on the wire, so it needs no
table: a subscribe gets an empty snapshot, and every push is an
``update`` whose row is ``{"action": name, "args": …}``.
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

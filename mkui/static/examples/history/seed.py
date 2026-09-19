"""Seed the running server with a few orders and a history worth reading.

Each order is placed, some are amended and filled, and one is undone — so
the table opens with a record sitting below the top of its own chain, its
redo branch still there, which is the state the history pane was built to
show. Run it once, against a running server:

    mkio serve
    python seed.py            # the server on port 8080
    python seed.py 9000       # `mkui serve . -p 9000`; also host:port, ws://…
"""

import asyncio
import sys

from mkio.client import MkioClient

URL = "ws://localhost:8080/ws"


def server_url(arg=None):
    """`9000` -> that port here, `host:9000` -> there, a ws:// URL as given."""
    if not arg:
        return URL
    if "://" in arg:
        return arg
    return f"ws://localhost:{arg}/ws" if arg.isdigit() else f"ws://{arg}/ws"

ORDERS = [
    {"side": "Buy",  "symbol": "AAPL", "qty": 500, "price": 190.25},
    {"side": "Sell", "symbol": "MSFT", "qty": 300, "price": 410.50},
    {"side": "Buy",  "symbol": "NVDA", "qty": 120, "price": 880.00},
    {"side": "Sell", "symbol": "TSLA", "qty": 80,  "price": 240.00},
]


async def send(client, data, op):
    reply = await client.send("orders", data, op=op)
    if reply.get("type") == "error" or reply.get("ok") is False:
        raise SystemExit(f"{op} failed: {reply}")
    return reply


async def ids_by_symbol(client):
    """The write path returns a ref, not the row: read the ids back."""
    async for msg in client.subscribe("all_orders", "query", updates=False,
                                      fields=["id", "symbol"]):
        return {r["symbol"]: r["id"] for r in msg.get("rows", [])}
    return {}


async def main():
    async with MkioClient(server_url(*sys.argv[1:2])) as client:
        for order in ORDERS:
            await send(client, order, "new")
            print(f"new    {order['side']:4} {order['symbol']:5} {order['qty']}")
        by_symbol = await ids_by_symbol(client)
        ids = [by_symbol[o["symbol"]] for o in ORDERS]

        # A pause between the stages, so the versions land at moments far
        # enough apart to pick between: "as of" is only interesting when
        # the history has distinguishable times in it.
        await asyncio.sleep(3)

        # A record with three versions: placed, amended, filled.
        await send(client, {"id": ids[0], "qty": 750, "price": 190.25}, "amend")
        await send(client, {"id": ids[0]}, "fill")
        print(f"order {ids[0]}: amended, then filled — three versions")

        await asyncio.sleep(3)

        # And one taken back: amended, cancelled, then undone — so it sits
        # at version 2 with version 3 still recorded above it, which the
        # history pane shows dimmed as the redo branch.
        await send(client, {"id": ids[1], "qty": 250, "price": 411.00}, "amend")
        await send(client, {"id": ids[1]}, "cancel")
        await send(client, {"id": ids[1]}, "undo")
        print(f"order {ids[1]}: amended, cancelled, then stepped back to v2")

        # A note on the first order. `note` is unversioned, so this changes
        # the row without recording a version: the table still says v3.
        await send(client, {"id": ids[0], "note": "client called to confirm"}, "note")
        print(f"order {ids[0]}: noted — still three versions")


if __name__ == "__main__":
    asyncio.run(main())

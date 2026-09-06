"""Seed the running mkio server with sample orders on a loop.

Most orders are top-level; some are child orders placed under a recent
pending order (and now and then under a child, so the Order Tree pane has
a third level to expand).
"""

import asyncio
import random

from mkio.client import MkioClient

URL = "ws://localhost:8080/ws"
SYMBOLS = ["AAPL", "GOOG", "MSFT", "AMZN", "TSLA", "NVDA"]
SIDES = ["Buy", "Sell"]


async def main():
    async with MkioClient(URL) as client:
        # Pick up where the table left off: pending orders can take children,
        # and ids continue from the highest one (this is the only writer).
        placed = []    # orders still pending: [(id, symbol, side, parent_id)]
        next_id = 1
        async for msg in client.subscribe(
            "all_orders", "query", updates=False,
            fields=["id", "symbol", "side", "status", "parent_id"],
        ):
            for r in msg.get("rows", []):
                next_id = max(next_id, r["id"] + 1)
                if r["status"] == "pending":
                    placed.append((r["id"], r["symbol"], r["side"], r["parent_id"]))
        while True:
            parent = None
            if placed and random.random() < 0.5:
                # A child order: same symbol and side as its parent, a slice
                # of its size. Prefer top-level parents so the tree stays
                # wide; every fifth child goes under another child.
                cands = [p for p in placed if p[3] is None] if random.random() < 0.8 else placed
                parent = random.choice(cands or placed)
                sym, side = parent[1], parent[2]
                qty = random.randint(1, 50)
            else:
                sym = random.choice(SYMBOLS)
                side = random.choice(SIDES)
                qty = random.randint(50, 500)
            price = round(random.uniform(100, 500), 2)
            data = {"side": side, "symbol": sym, "qty": qty, "price": price}
            if parent:
                data["parent_id"] = parent[0]
                resp = await client.send("orders", data, op="child")
            else:
                resp = await client.send("orders", data, op="new")
            if resp.get("ok"):
                placed.append((next_id, sym, side, parent[0] if parent else None))
                under = f"  under #{parent[0]}" if parent else ""
                print(f"  new  #{next_id}  {side} {qty} {sym} @ {price}{under}")
                next_id += 1

            await asyncio.sleep(random.uniform(0.4, 1.2))

            if placed and random.random() < 0.4:
                # Fill or cancel a pending order — leaves first, so parents
                # keep their children around for a while.
                leaves = [p for p in placed if not any(q[3] == p[0] for q in placed)]
                victim = random.choice(leaves or placed)
                placed.remove(victim)
                op = random.choice(["fill", "cancel"])
                await client.send("orders", {"id": victim[0]}, op=op)
                print(f"  {op:6s} #{victim[0]}")

            await asyncio.sleep(random.uniform(0.3, 0.8))


if __name__ == "__main__":
    asyncio.run(main())

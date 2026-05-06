"""Seed the running mkio server with sample orders on a loop."""

import asyncio
import random

from mkio.client import MkioClient

URL = "ws://localhost:8080/ws"
SYMBOLS = ["AAPL", "GOOG", "MSFT", "AMZN", "TSLA", "NVDA"]
SIDES = ["Buy", "Sell"]


async def main():
    async with MkioClient(URL) as client:
        placed = []
        next_id = 1
        while True:
            sym = random.choice(SYMBOLS)
            side = random.choice(SIDES)
            price = round(random.uniform(100, 500), 2)
            qty = random.randint(1, 200)
            resp = await client.send(
                "orders", {"side": side, "symbol": sym, "qty": qty, "price": price},
                op="new",
            )
            if resp.get("ok"):
                placed.append(next_id)
                print(f"  new  #{next_id}  {side} {qty} {sym} @ {price}")
                next_id += 1

            await asyncio.sleep(random.uniform(0.4, 1.2))

            if placed and random.random() < 0.6:
                oid = placed.pop(random.randint(0, len(placed) - 1))
                op = random.choice(["fill", "cancel"])
                await client.send("orders", {"id": oid}, op=op)
                print(f"  {op:6s} #{oid}")

            await asyncio.sleep(random.uniform(0.3, 0.8))

if __name__ == "__main__":
    asyncio.run(main())

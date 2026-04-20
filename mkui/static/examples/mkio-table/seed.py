"""Seed the running mkio server with sample orders on a loop."""

import asyncio
import json
import random
import websockets

URL = "ws://localhost:8080/ws"
SYMBOLS = ["AAPL", "GOOG", "MSFT", "AMZN", "TSLA", "NVDA"]
SIDES = ["Buy", "Sell"]

_counter = 0

def _ref():
    global _counter
    _counter += 1
    return f"seed-{_counter}"

async def main():
    async with websockets.connect(URL) as ws:
        placed = []
        next_id = 1
        while True:
            # Place a new order
            sym = random.choice(SYMBOLS)
            side = random.choice(SIDES)
            price = round(random.uniform(100, 500), 2)
            qty = random.randint(1, 200)
            ref = _ref()
            await ws.send(json.dumps({
                "service": "orders", "op": "new", "ref": ref,
                "data": {"side": side, "symbol": sym, "qty": qty, "price": price},
            }))
            resp = json.loads(await ws.recv())
            if resp.get("type") == "result":
                placed.append(next_id)
                print(f"  new  #{next_id}  {side} {qty} {sym} @ {price}")
                next_id += 1

            await asyncio.sleep(random.uniform(0.4, 1.2))

            # Randomly fill or cancel an older order
            if placed and random.random() < 0.6:
                oid = placed.pop(random.randint(0, len(placed) - 1))
                op = random.choice(["fill", "cancel"])
                ref = _ref()
                await ws.send(json.dumps({
                    "service": "orders", "op": op, "ref": ref,
                    "data": {"id": oid},
                }))
                resp = json.loads(await ws.recv())
                print(f"  {op:6s} #{oid}")

            await asyncio.sleep(random.uniform(0.3, 0.8))

if __name__ == "__main__":
    asyncio.run(main())

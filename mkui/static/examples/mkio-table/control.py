"""Drive the running app from Python through the control channel.

    python control.py            # instead of `mkui serve .`

Serves the example like `mkui serve` does, and once a browser is open
rewires its tables every few seconds: links Pending to All Orders by
symbol, pauses the link, and clears it again. Every step is an mkui
action — the same `table.link` / `table.filter` a menu item would fire —
pushed to every subscribed tab (or one login's tabs with `user=`).
"""

import asyncio
import tomllib
from pathlib import Path

import mkui
from mkio import create_app
from mkui.control import install

HERE = Path(__file__).parent

with open(HERE / "server.toml", "rb") as f:
    config = tomllib.load(f)
for key, value in config.get("static", {}).items():
    if value == "<mkui.static_dir>":
        config["static"][key] = str(mkui.static_dir)

app = create_app(config)
control = install(app)          # registers the "_mkui" service; client.toml names it


async def script():
    while control.subscribers == 0:          # a browser tab must be listening
        await asyncio.sleep(1)
    await asyncio.sleep(1)
    print(f"{control.subscribers} tab(s) listening as {control.users()}")
    n = await control.link("pending", listen={"symbol": "symbol"})
    print("linked Pending to All Orders by symbol ->", n, "tab(s)")
    await asyncio.sleep(5)
    await control.link("pending", listening=False)
    print("paused the link")
    await asyncio.sleep(5)
    await control.send("table.filter", {"pane": "all-orders", "filters": {"side": ["Buy"]}, "merge": True})
    print("filtered All Orders to Buy")


async def on_started():
    asyncio.create_task(script())


app.on_startup(on_started)

if __name__ == "__main__":
    print(f"mkui v{mkui.__version__} — http://localhost:{config.get('port', 8080)}/")
    app.run()

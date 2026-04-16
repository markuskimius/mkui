"""mkui — config-driven web GUI framework with dockable panes."""

from pathlib import Path

__version__ = "0.1.0"

static_dir = Path(__file__).parent / "static"
"""Path to the directory containing mkui's JS, CSS, and example files.

Serve this directory from your web server to make mkui available to browsers::

    # With mkio:
    [static]
    "/mkui" = "<mkui.static_dir>"

    # With any ASGI/WSGI framework:
    import mkui
    app.mount("/mkui", StaticFiles(directory=mkui.static_dir))
"""

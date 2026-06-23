"""Shared test helper: build the plugin ``context`` dict that ``routes.setup()``
expects.

The Slopsmith plugin loader passes ``setup(app, context)`` a context with
``config_dir``, ``meta_db``, ``get_dlc_dir``, ``extract_meta``, ``load_sibling``
(and ``log``). Tests only need realistic stubs for the first few plus a working
``load_sibling`` so ``routes.setup`` can pull in its ``host_download`` /
``unlock_cache`` siblings. Centralising this keeps every ``_make_app_with_routes``
helper in sync with the loader contract.

Plain module (no pytest import) so it works under both the pytest and the
``unittest discover`` runners.
"""
import importlib.util
from pathlib import Path
from types import SimpleNamespace

_PLUGIN_DIR = Path(__file__).resolve().parents[1]


def _load_sibling(name):
    path = _PLUGIN_DIR / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"the_daily_test_sibling_{name}", str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_context(base_dir, meta_db=None):
    """Production-shaped plugin context for ``routes.setup(app, context)``."""
    return {
        "config_dir": base_dir,
        "meta_db": meta_db if meta_db is not None else SimpleNamespace(conn=None),
        "get_dlc_dir": lambda: Path(base_dir),
        "extract_meta": lambda *args, **kwargs: {},
        "load_sibling": _load_sibling,
    }

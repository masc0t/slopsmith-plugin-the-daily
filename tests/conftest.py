import sqlite3
import pytest

# Monkeypatch sqlite3.connect to force memory mode for test db files
# This prevents PermissionError: [WinError 32] on Windows when cleaning up temp dirs
original_connect = sqlite3.connect

def patched_connect(database, *args, **kwargs):
    if isinstance(database, str) and "the_daily.db" in database:
        return original_connect(":memory:", *args, **kwargs)
    return original_connect(database, *args, **kwargs)

sqlite3.connect = patched_connect

@pytest.fixture(autouse=True)
def clean_db_path(monkeypatch):
    from plugins.the_daily import routes
    monkeypatch.setattr(routes, "_db_path", "the_daily.db")
    routes._close_conn()
    yield
    routes._close_conn()

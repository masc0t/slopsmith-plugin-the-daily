#!/usr/bin/env python3
"""Tests for economy - token awards and ledger."""

import json
import os
import tempfile
from datetime import date, timezone
from pathlib import Path
from types import SimpleNamespace
import importlib.util
from _routes_test_helper import make_context

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _load_routes_module(base_dir: Path):
    path = Path(__file__).resolve().parents[1] / 'routes.py'
    spec = importlib.util.spec_from_file_location("the_daily_routes", str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _make_app_with_routes(base_dir: Path, today: str = "2026-04-24"):
    routes = _load_routes_module(base_dir)
    routes.SUPABASE_URL = ""
    routes._lb_cache.clear()
    routes._close_conn()
    routes._db_path = ":memory:"
    os.environ["THE_DAILY_TEST_TODAY"] = today
    app = FastAPI()
    routes.setup(app, make_context(base_dir))
    return app, routes


class TestAwardTokens:
    """Unit tests for token award logic."""

    def test_award_tokens_creates_ledger_entry(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            conn.execute(
                "INSERT INTO daily_inventory (install_id, tokens) VALUES (?, ?)",
                ("token_award_test", 0),
            )
            conn.commit()
            routes._award_tokens(conn, "token_award_test", "2026-04-24", 10, "test_award")
            row = conn.execute(
                "SELECT delta, reason FROM daily_token_ledger WHERE install_id = ? ORDER BY created_at DESC",
                ("token_award_test",)
            ).fetchone()
            assert row[0] == 10
            assert row[1] == "test_award"

    def test_award_tokens_updates_balance(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            conn.execute(
                "INSERT INTO daily_inventory (install_id, tokens) VALUES (?, ?)",
                ("token_balance_test", 5),
            )
            conn.commit()
            routes._award_tokens(conn, "token_balance_test", "2026-04-24", 10, "test_award")
            balance = routes._get_token_balance(conn, "token_balance_test")
            assert balance == 15


class TestTokenBalance:
    """Unit tests for token balance retrieval."""

    def test_get_token_balance_empty(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            balance = routes._get_token_balance(conn, "nonexistent_install")
            assert balance == 0

    def test_get_token_balance_with_tokens(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            conn.execute(
                "INSERT INTO daily_inventory (install_id, tokens) VALUES (?, ?)",
                ("has_tokens", 42),
            )
            conn.commit()
            balance = routes._get_token_balance(conn, "has_tokens")
            assert balance == 42


class TestTokenLedger:
    """Tests for token ledger table."""

    def test_ledger_records_all_transactions(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            conn.execute(
                "INSERT INTO daily_inventory (install_id, tokens) VALUES (?, ?)",
                ("ledger_test", 0),
            )
            routes._award_tokens(conn, "ledger_test", "2026-04-24", 10, "completion")
            routes._award_tokens(conn, "ledger_test", "2026-04-24", 5, "bonus")
            rows = conn.execute(
                "SELECT delta, reason FROM daily_token_ledger WHERE install_id = ? ORDER BY created_at",
                ("ledger_test",)
            ).fetchall()
            assert len(rows) == 2
            assert rows[0][0] == 10
            assert rows[1][0] == 5


class TestStreakEndpoint:
    """Integration tests for /streak endpoint."""

    def test_streak_endpoint(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            resp = client.get("/api/plugins/the_daily/streak", headers={"X-Daily-Install-Id": "streak_test"})
            assert resp.status_code == 200
            data = resp.json()
            assert "streak" in data

    def test_streak_without_install_id_returns_defaults(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            resp = client.get("/api/plugins/the_daily/streak")
            assert resp.status_code == 200
            data = resp.json()
            assert "streak" in data
            assert data["streak"] == 0


class TestStatsEndpoint:
    """Integration tests for /stats endpoint."""

    def test_stats_endpoint(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            resp = client.get("/api/plugins/the_daily/stats")
            assert resp.status_code == 200
            data = resp.json()
            assert "total_played" in data
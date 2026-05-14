#!/usr/bin/env python3
"""Tests for consumable items (boss reroll, lane reroll)."""

import json
import os
import tempfile
from datetime import date, timezone
from pathlib import Path
from types import SimpleNamespace
import importlib.util

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
    routes.setup(app, {"config_dir": base_dir, "meta_db": SimpleNamespace(conn=None)})
    return app, routes


class TestApplyBossReroll:
    """Unit tests for _apply_boss_reroll."""

    def test_apply_boss_reroll_no_reroll(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            map_data = {"nodes": [{"id": "boss", "cf_id": 1}]}
            songs = [{"cf_id": 1, "title": "Original"}]
            result_map, result_songs, applied = routes._apply_boss_reroll(
                conn, "2026-04-24", map_data, songs, "no_reroll_install"
            )
            assert applied is False
            assert result_map["nodes"][0]["cf_id"] == 1


class TestUseItemEndpoint:
    """Integration tests for /use-item endpoint."""

    def test_use_item_unknown_item(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            resp = client.post(
                "/api/plugins/the_daily/use-item",
                json={"item_id": "nonexistent", "install_id": "use_item_test"},
            )
            data = resp.json()
            assert "error" in data or data.get("success") is False

    def test_use_item_missing_item_id(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            resp = client.post(
                "/api/plugins/the_daily/use-item",
                json={"install_id": "use_item_test"},
            )
            data = resp.json()
            assert "error" in data


class TestBossRerollTable:
    """Tests for boss reroll database table."""

    def test_boss_reroll_table_exists(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            conn.execute(
                "INSERT INTO daily_boss_rerolls (install_id, date, rerolled_cf_id) VALUES (?, ?, ?)",
                ("test_reroll", "2026-04-24", 999),
            )
            conn.commit()
            row = conn.execute(
                "SELECT install_id, date, rerolled_cf_id FROM daily_boss_rerolls WHERE install_id = ?",
                ("test_reroll",),
            ).fetchone()
            assert row is not None
            assert row[2] == 999


class TestConsumablesConstants:
    """Tests for consumable constants."""

    def test_consumables_defined(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            assert "boss_reroll" in routes.CONSUMABLES
            assert "lane_reroll" in routes.CONSUMABLES

    def test_boss_reroll_cost(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            assert routes.CONSUMABLES["boss_reroll"]["cost"] == 8
            assert routes.CONSUMABLES["lane_reroll"]["cost"] == 12
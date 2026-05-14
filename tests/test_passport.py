#!/usr/bin/env python3
"""Tests for passport, stamps, and streak functionality."""

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


class TestIsDayComplete:
    """Unit tests for _is_day_complete."""

    def test_complete_without_map(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            today = routes._get_today().isoformat()
            conn.execute(
                "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count) VALUES (?, ?, ?, ?, ?)",
                (today, "Day 1", "e_standard", "[]", 3),
            )
            conn.execute(
                "INSERT INTO daily_completions (date, cf_id, install_id) VALUES (?, ?, ?)",
                (today, 1, "install_abc"),
            )
            conn.execute(
                "INSERT INTO daily_completions (date, cf_id, install_id) VALUES (?, ?, ?)",
                (today, 2, "install_abc"),
            )
            conn.execute(
                "INSERT INTO daily_completions (date, cf_id, install_id) VALUES (?, ?, ?)",
                (today, 3, "install_abc"),
            )
            conn.commit()
            assert routes._is_day_complete(conn, today) is True

    def test_incomplete_without_map(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            today = routes._get_today().isoformat()
            conn.execute(
                "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count) VALUES (?, ?, ?, ?, ?)",
                (today, "Day 1", "e_standard", "[]", 3),
            )
            conn.execute(
                "INSERT INTO daily_completions (date, cf_id, install_id) VALUES (?, ?, ?)",
                (today, 1, "install_abc"),
            )
            conn.commit()
            assert routes._is_day_complete(conn, today) is False


class TestComputeStampAggregates:
    """Unit tests for _compute_stamp_aggregates."""

    def test_empty_install(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            agg = routes._compute_stamp_aggregates(conn, "install_123")
            assert agg["total_completions"] == 0
            assert agg["streak"] == 0
            assert agg["lane_clears"] == {}
            assert agg["modifiers_seen"] == []
            assert agg["decades_seen"] == []

    def test_modifier_tracking(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            conn.execute(
                "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count) VALUES (?, ?, ?, ?, ?)",
                ("2026-04-22", "Day 1", "e_standard", "[]", 5),
            )
            conn.execute(
                "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count) VALUES (?, ?, ?, ?, ?)",
                ("2026-04-23", "Day 2", "metal_mix", "[]", 5),
            )
            conn.execute(
                "INSERT INTO daily_completions (date, cf_id, install_id) VALUES (?, ?, ?)",
                ("2026-04-22", 1, "install_abc"),
            )
            conn.execute(
                "INSERT INTO daily_completions (date, cf_id, install_id) VALUES (?, ?, ?)",
                ("2026-04-23", 1, "install_abc"),
            )
            conn.commit()
            agg = routes._compute_stamp_aggregates(conn, "install_abc")
            assert "e_standard" in agg["modifiers_seen"]
            assert "metal_mix" in agg["modifiers_seen"]


class TestCheckStamps:
    """Unit tests for _check_stamps."""

    def test_check_stamps_returns_list(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            new = routes._check_stamps(conn, "install_no_completions")
            assert isinstance(new, list)


class TestPassportEndpoint:
    """Integration tests for /passport endpoint."""

    def test_passport_empty_install(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            today = routes._get_today().isoformat()
            conn.execute(
                "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count) VALUES (?, ?, ?, ?, ?)",
                (today, "Day 1", "e_standard", "[]", 5),
            )
            conn.commit()
            client = TestClient(app)
            resp = client.get("/api/plugins/the_daily/passport", headers={"X-Daily-Install-Id": "install_new"})
            assert resp.status_code == 200
            data = resp.json()
            assert "days" in data
            assert "totals" in data
            assert data["totals"]["total_dailies"] == 0

    def test_passport_requires_install_id(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            resp = client.get("/api/plugins/the_daily/passport")
            assert resp.status_code == 200
            data = resp.json()
            assert "error" in data

    def test_passport_with_map_completion(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            today = routes._get_today().isoformat()
            map_json = json.dumps({
                "lanes": {"standard": {}, "sprint": {}},
                "nodes": [
                    {"id": "n1", "lane": "sprint", "row": 0, "cf_id": 1},
                    {"id": "boss", "lane": "standard", "row": 1, "cf_id": 2},
                ],
                "boss": "boss",
            })
            conn.execute(
                "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count, map) VALUES (?, ?, ?, ?, ?, ?)",
                (today, "Day 1", "e_standard", "[]", 2, map_json),
            )
            conn.execute(
                "INSERT INTO daily_completions (date, cf_id, install_id, node_id, committed_lane) VALUES (?, ?, ?, ?, ?)",
                (today, 1, "install_map", "n1", "sprint"),
            )
            conn.execute(
                "INSERT INTO daily_completions (date, cf_id, install_id, node_id, committed_lane) VALUES (?, ?, ?, ?, ?)",
                (today, 2, "install_map", "boss", "standard"),
            )
            conn.commit()
            client = TestClient(app)
            resp = client.get("/api/plugins/the_daily/passport", headers={"X-Daily-Install-Id": "install_map"})
            assert resp.status_code == 200
            data = resp.json()
            assert len(data["days"]) >= 1
            day_data = next((d for d in data["days"] if d["date"] == today), None)
            assert day_data is not None
            assert day_data["boss_done"] is True


class TestStreakCalculation:
    """Tests for streak calculation in passport."""

    def test_consecutive_days_streak(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base, today="2026-04-26")
            conn = routes._get_conn()
            for i, d in enumerate(["2026-04-22", "2026-04-23", "2026-04-24", "2026-04-25", "2026-04-26"]):
                map_json = json.dumps({
                    "lanes": {"standard": {}},
                    "nodes": [{"id": "boss", "lane": "standard", "row": 0}],
                    "boss": "boss",
                })
                conn.execute(
                    "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count, map) VALUES (?, ?, ?, ?, ?, ?)",
                    (d, f"Day {i+1}", "e_standard", "[]", 2, map_json),
                )
                conn.execute(
                    "INSERT INTO daily_completions (date, cf_id, install_id, node_id, committed_lane) VALUES (?, ?, ?, ?, ?)",
                    (d, 1, "streak_install", "boss", "standard"),
                )
                conn.execute(
                    "INSERT INTO daily_completions (date, cf_id, install_id, node_id, committed_lane) VALUES (?, ?, ?, ?, ?)",
                    (d, 2, "streak_install", "boss", "standard"),
                )
            conn.commit()
            client = TestClient(app)
            resp = client.get("/api/plugins/the_daily/passport", headers={"X-Daily-Install-Id": "streak_install"})
            data = resp.json()
            assert data["totals"]["current_streak"] == 5


class TestInventoryEndpoint:
    """Tests for /inventory endpoint."""

    def test_inventory_empty(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            resp = client.get("/api/plugins/the_daily/inventory", headers={"X-Daily-Install-Id": "inv_test"})
            assert resp.status_code == 200
            data = resp.json()
            assert "tokens" in data
            assert data["tokens"] == 0

    def test_inventory_requires_install_id(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            resp = client.get("/api/plugins/the_daily/inventory")
            assert resp.status_code == 200
            data = resp.json()
            assert "error" in data
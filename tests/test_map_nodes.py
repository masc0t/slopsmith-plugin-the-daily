#!/usr/bin/env python3
"""Tests for map node interactions (treasure, rest, shop, boss)."""

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


class TestTreasureEndpoint:
    """Integration tests for /treasure/{node_id} endpoints."""

    def test_treasure_get(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            today = routes._get_today().isoformat()
            map_json = json.dumps({
                "lanes": {"standard": {}},
                "nodes": [
                    {"id": "treasure_1", "type": "treasure", "lane": "standard", "row": 0},
                ],
            })
            conn.execute(
                "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count, map) VALUES (?, ?, ?, ?, ?, ?)",
                (today, "Day 1", "e_standard", "[]", 2, map_json),
            )
            conn.commit()
            client = TestClient(app)
            resp = client.get("/api/plugins/the_daily/treasure/treasure_1", headers={"X-Daily-Install-Id": "treasure_test"})
            assert resp.status_code == 200

    def test_treasure_post(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            today = routes._get_today().isoformat()
            map_json = json.dumps({
                "lanes": {"standard": {}},
                "nodes": [
                    {"id": "treasure_1", "type": "treasure", "lane": "standard", "row": 0, "cf_ids": [1, 2, 3]},
                ],
            })
            songs_json = json.dumps([
                {"cf_id": 1, "artist": "Artist1", "title": "Song1"},
                {"cf_id": 2, "artist": "Artist2", "title": "Song2"},
                {"cf_id": 3, "artist": "Artist3", "title": "Song3"},
            ])
            conn.execute(
                "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count, map) VALUES (?, ?, ?, ?, ?, ?)",
                (today, "Day 1", "e_standard", songs_json, 3, map_json),
            )
            conn.commit()
            client = TestClient(app)
            resp = client.post(
                "/api/plugins/the_daily/treasure/treasure_1",
                json={"cf_id": 2},
                headers={"X-Daily-Install-Id": "treasure_pick_test"},
            )
            assert resp.status_code == 200


class TestRestEndpoint:
    """Integration tests for /rest/{node_id} endpoints."""

    def test_rest_get(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            today = routes._get_today().isoformat()
            map_json = json.dumps({
                "lanes": {"standard": {}},
                "nodes": [
                    {"id": "rest_1", "type": "rest", "lane": "standard", "row": 0},
                ],
            })
            conn.execute(
                "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count, map) VALUES (?, ?, ?, ?, ?, ?)",
                (today, "Day 1", "e_standard", "[]", 2, map_json),
            )
            conn.commit()
            client = TestClient(app)
            resp = client.get("/api/plugins/the_daily/rest/rest_1", headers={"X-Daily-Install-Id": "rest_test"})
            assert resp.status_code == 200

    def test_rest_post(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            today = routes._get_today().isoformat()
            map_json = json.dumps({
                "lanes": {"standard": {}},
                "nodes": [
                    {"id": "rest_1", "type": "rest", "lane": "standard", "row": 0},
                ],
            })
            conn.execute(
                "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count, map) VALUES (?, ?, ?, ?, ?, ?)",
                (today, "Day 1", "e_standard", "[]", 2, map_json),
            )
            conn.commit()
            client = TestClient(app)
            resp = client.post(
                "/api/plugins/the_daily/rest/rest_1",
                json={"action": "heal"},
                headers={"X-Daily-Install-Id": "rest_action_test"},
            )
            assert resp.status_code == 200


class TestNodeClearEndpoint:
    """Integration tests for /nodes/{node_id}/clear endpoint."""

    def test_clear_node(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            today = routes._get_today().isoformat()
            map_json = json.dumps({
                "lanes": {"standard": {}},
                "nodes": [
                    {"id": "n1", "type": "normal", "lane": "standard", "row": 0, "cf_id": 1},
                ],
            })
            songs_json = json.dumps([{"cf_id": 1, "artist": "Test", "title": "TestSong"}])
            conn.execute(
                "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count, map) VALUES (?, ?, ?, ?, ?, ?)",
                (today, "Day 1", "e_standard", songs_json, 1, map_json),
            )
            conn.commit()
            client = TestClient(app)
            resp = client.post(
                "/api/plugins/the_daily/nodes/n1/clear",
                json={"cf_id": 1},
                headers={"X-Daily-Install-Id": "clear_test"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert "success" in data or "error" not in data


class TestMapNodeHelpers:
    """Unit tests for map node helper functions."""

    def test_node_by_id(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            map_data = {
                "nodes": [
                    {"id": "n1", "type": "normal"},
                    {"id": "boss", "type": "boss"},
                ]
            }
            nodes = routes._node_by_id(map_data)
            assert nodes["n1"]["type"] == "normal"
            assert nodes["boss"]["type"] == "boss"

    def test_node_by_id_empty(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            nodes = routes._node_by_id({"nodes": []})
            assert len(nodes) == 0

    def test_song_by_id(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            songs = [
                {"cf_id": 1, "title": "Song1"},
                {"cf_id": 2, "title": "Song2"},
            ]
            song_map = routes._song_by_id(songs)
            assert song_map[1]["title"] == "Song1"
            assert song_map[2]["title"] == "Song2"

    def test_node_song_ids_single_cf_id(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            node = {"cf_id": 1}
            assert routes._node_song_ids(node) == [1]

    def test_node_song_ids_no_cf_id(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            node = {"type": "rest"}
            assert routes._node_song_ids(node) == []


class TestMapAvailableState:
    """Unit tests for map availability logic."""

    def test_map_available_state_with_map(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            today = routes._get_today().isoformat()
            map_json = json.dumps({
                "start": "n1",
                "lanes": {"standard": {}},
                "nodes": [
                    {"id": "n1", "type": "normal", "lane": "standard", "row": 0},
                ],
            })
            conn.execute(
                "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count, map) VALUES (?, ?, ?, ?, ?, ?)",
                (today, "Day 1", "e_standard", "[]", 2, map_json),
            )
            conn.commit()
            state = routes._map_available_state(conn, today, json.loads(map_json), "test_install")
            assert "available_node_ids" in state
            assert "n1" in state["available_node_ids"]

    def test_map_available_state_with_cleared(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            today = routes._get_today().isoformat()
            map_json = json.dumps({
                "start": "n1",
                "lanes": {"standard": {}},
                "nodes": [
                    {"id": "n1", "type": "normal", "lane": "standard", "row": 0},
                ],
            })
            conn.execute(
                "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count, map) VALUES (?, ?, ?, ?, ?, ?)",
                (today, "Day 1", "e_standard", "[]", 2, map_json),
            )
            conn.execute(
                "INSERT INTO daily_node_commits (install_id, date, node_id, cf_id) VALUES (?, ?, ?, ?)",
                ("test_install", today, "n1", 1),
            )
            conn.commit()
            state = routes._map_available_state(conn, today, json.loads(map_json), "test_install")
            assert "n1" in state["committed_node_ids"]
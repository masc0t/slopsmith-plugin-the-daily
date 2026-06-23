#!/usr/bin/env python3
"""Tests for mystery events (guess_year, blind_pick, replay)."""

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


class TestMysteryEventHelpers:
    """Unit tests for mystery event builders."""

    def test_mystery_event_seed_deterministic(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            seed1 = routes._mystery_event_seed("2026-04-24", "mystery_1")
            seed2 = routes._mystery_event_seed("2026-04-24", "mystery_1")
            assert seed1 == seed2

    def test_mystery_event_seed_changes_by_node(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            seed1 = routes._mystery_event_seed("2026-04-24", "mystery_1")
            seed2 = routes._mystery_event_seed("2026-04-24", "mystery_2")
            assert seed1 != seed2


class TestBuildGuessYear:
    """Unit tests for _build_guess_year."""

    def test_build_guess_year_structure(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            pool = [
                {"cf_id": 1, "artist": "Test", "title": "Song1", "year": 1985},
                {"cf_id": 2, "artist": "Test2", "title": "Song2", "year": 1990},
            ]
            result = routes._build_guess_year("2026-04-24", "mystery_1", pool)
            assert result["event_type"] == "guess_year"
            assert "event_payload" in result

    def test_build_guess_year_has_answer(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            pool = [
                {"cf_id": 1, "artist": "Test", "title": "Song1", "year": 1985},
            ]
            result = routes._build_guess_year("2026-04-24", "mystery_1", pool)
            payload = result["event_payload"]
            assert "answer_year" in payload


class TestBuildBlindPick:
    """Unit tests for _build_blind_pick."""

    def test_build_blind_pick_structure(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            pool = [
                {"cf_id": 1, "artist": "Test", "title": "Song1"},
                {"cf_id": 2, "artist": "Test2", "title": "Song2"},
            ]
            result = routes._build_blind_pick("2026-04-24", "mystery_1", pool)
            assert result["event_type"] == "blind_pick"
            assert "event_payload" in result


class TestBuildReplay:
    """Unit tests for _build_replay."""

    def test_build_replay_structure(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            pool = [
                {"cf_id": 1, "artist": "Test", "title": "Song1"},
            ]
            result = routes._build_replay("2026-04-24", "mystery_1", pool)
            assert result["event_type"] == "replay"
            assert "event_payload" in result


class TestMysteryEndpoints:
    """Integration tests for mystery endpoints."""

    def test_mystery_get_no_map(self):
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
            resp = client.get("/api/plugins/the_daily/mystery/mystery_1", headers={"X-Daily-Install-Id": "mystery_test"})
            data = resp.json()
            assert "error" in str(data) or "Map Mode" in str(data)

    def test_mystery_submit_guess_year(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            today = routes._get_today().isoformat()
            map_json = json.dumps({
                "lanes": {"standard": {}},
                "nodes": [
                    {"id": "mystery_1", "type": "mystery", "event_type": "guess_year", "lane": "standard", "row": 0, "event_payload": {"answer_year": 1985, "song": {"year": 1985}}},
                ],
            })
            conn.execute(
                "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count, map) VALUES (?, ?, ?, ?, ?, ?)",
                (today, "Day 1", "e_standard", "[]", 2, map_json),
            )
            conn.commit()
            client = TestClient(app)
            resp = client.post(
                "/api/plugins/the_daily/mystery/mystery_1/submit",
                json={"guess": 1985},
                headers={"X-Daily-Install-Id": "mystery_submit_test"},
            )
            assert resp.status_code == 200


class TestEnrichMysteryNode:
    """Unit tests for _enrich_mystery_node."""

    def test_enrich_mystery_node(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            pool = [
                {"cf_id": 1, "artist": "Test", "title": "Song1", "year": 1985},
                {"cf_id": 2, "artist": "Test2", "title": "Song2", "year": 1990},
            ]
            node = {"id": "mystery_1", "type": "mystery", "lane": "standard", "row": 0}
            result = routes._enrich_mystery_node("2026-04-24", node, pool)
            assert result["type"] == "mystery"
            assert "event_type" in result
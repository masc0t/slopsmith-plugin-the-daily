import pytest
from pathlib import Path
import tempfile
import os
import json
from datetime import date, datetime
from types import SimpleNamespace
import importlib.util
from fastapi import FastAPI
from fastapi.testclient import TestClient

def _load_routes_module(_base_dir: Path):
    path = Path(__file__).resolve().parents[1] / 'routes.py'
    spec = importlib.util.spec_from_file_location("the_daily_routes_wof", str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def _make_app_with_routes(base_dir: Path, supabase_url: str = "https://example.supabase.co"):
    routes = _load_routes_module(base_dir)
    routes.SUPABASE_URL = supabase_url
    routes._db_path = "the_daily.db"
    # Freeze today's date
    os.environ["THE_DAILY_TEST_TODAY"] = "2026-04-24"
    app = FastAPI()
    routes.setup(app, {"config_dir": base_dir, "meta_db": SimpleNamespace(conn=None)})
    return app, routes

def test_sign_leaderboard_success(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        app, routes = _make_app_with_routes(base)
        conn = routes._get_conn()
        
        today_iso = "2026-04-24"
        # Setup today's setlist
        conn.execute(
            "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count) VALUES (?, ?, ?, ?, ?)",
            (today_iso, "Test Day", "e_standard", "[]", 1)
        )
        # Mark as complete
        conn.execute(
            "INSERT INTO daily_completions (date, cf_id) VALUES (?, ?)",
            (today_iso, 123)
        )
        # Update song_count to 1 so 1 completion is enough
        conn.execute("UPDATE daily_setlists SET song_count = 1 WHERE date = ?", (today_iso,))
        conn.commit()

        # Mock Supabase
        posted_bodies = []
        def fake_supabase_post(path, body):
            posted_bodies.append(body)
            return 201

        def fake_compute_streak(ip, today):
            return 5

        monkeypatch.setattr(routes, "_supabase_post", fake_supabase_post)
        monkeypatch.setattr(routes, "_compute_streak_from_supabase", fake_compute_streak)
        monkeypatch.setattr(routes, "_check_ip_rate_limit", lambda ip, today: True)

        client = TestClient(app)
        payload = {
            "display_name": "PlayerOne",
            "rating": 1,
            "message": "Fun setlist!"
        }
        resp = client.post("/api/plugins/the_daily/sign", json=payload)
        
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["streak"] == 6 # 5 + 1
        
        assert len(posted_bodies) == 1
        body = posted_bodies[0]
        assert body["display_name"] == "PlayerOne"
        assert body["rating"] == 1
        assert body["message"] == "Fun setlist!"
        assert body["streak"] == 6
        assert body["date"] == today_iso

def test_sign_leaderboard_incomplete(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        app, routes = _make_app_with_routes(base)
        conn = routes._get_conn()
        
        today_iso = "2026-04-24"
        # Setup today's setlist with 2 songs
        conn.execute(
            "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count) VALUES (?, ?, ?, ?, ?)",
            (today_iso, "Test Day", "e_standard", "[]", 2)
        )
        # Only 1 completion
        conn.execute(
            "INSERT INTO daily_completions (date, cf_id) VALUES (?, ?)",
            (today_iso, 123)
        )
        conn.commit()

        client = TestClient(app)
        payload = {"display_name": "PlayerOne"}
        resp = client.post("/api/plugins/the_daily/sign", json=payload)
        
        assert resp.status_code == 200 # App returns 200 with error field usually
        assert resp.json()["error"] == "Setlist not complete yet"

def test_sign_leaderboard_invalid_name(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        app, routes = _make_app_with_routes(base)
        
        client = TestClient(app)
        payload = {"display_name": "A"} # Too short
        resp = client.post("/api/plugins/the_daily/sign", json=payload)
        assert "error" in resp.json()
        assert "Name must be" in resp.json()["error"]

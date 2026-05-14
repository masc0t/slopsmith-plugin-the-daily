#!/usr/bin/env python3
"""Tests for shop, inventory, and purchase functionality."""

import json
import os
import tempfile
from datetime import date, datetime, timedelta, timezone
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


class TestShopOffer:
    """Unit tests for shop offer generation."""

    def test_shop_offer_deterministic(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            offer1 = routes._shop_offer_for_node("2026-04-24", "node_1")
            offer2 = routes._shop_offer_for_node("2026-04-24", "node_1")
            assert offer1 == offer2

    def test_shop_offer_changes_by_date(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            offer1 = routes._shop_offer_for_node("2026-04-24", "node_1")
            offer2 = routes._shop_offer_for_node("2026-04-25", "node_1")
            assert offer1 != offer2

    def test_shop_offer_changes_by_node(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            offer1 = routes._shop_offer_for_node("2026-04-24", "node_1")
            offer2 = routes._shop_offer_for_node("2026-04-24", "node_2")
            assert offer1 != offer2


class TestShopEndpoint:
    """Integration tests for /shop endpoint."""

    def test_shop_returns_items(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            resp = client.get("/api/plugins/the_daily/shop", headers={"X-Daily-Install-Id": "shop_test"})
            assert resp.status_code == 200
            data = resp.json()
            assert "items" in data
            assert "tokens" in data

    def test_shop_without_install_id_returns_defaults(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            resp = client.get("/api/plugins/the_daily/shop")
            assert resp.status_code == 200
            data = resp.json()
            assert "items" in data
            assert data["tokens"] == 0

    def test_shop_has_cosmetics(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            resp = client.get("/api/plugins/the_daily/shop", headers={"X-Daily-Install-Id": "cosmetics_test"})
            data = resp.json()
            cosmetics = [i for i in data["items"] if i.get("is_cosmetic")]
            assert len(cosmetics) > 0
            assert any(i["id"] == "flair_glow" for i in cosmetics)

    def test_shop_has_consumables(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            resp = client.get("/api/plugins/the_daily/shop", headers={"X-Daily-Install-Id": "consumable_test"})
            data = resp.json()
            consumables = [i for i in data["items"] if not i.get("is_cosmetic")]
            assert len(consumables) > 0

    def test_shop_with_node_discount(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            resp = client.get("/api/plugins/the_daily/shop?node_id=treasure_1", headers={"X-Daily-Install-Id": "discount_test"})
            data = resp.json()
            assert data.get("discount") is not None


class TestInventoryPayload:
    """Unit tests for _inventory_payload."""

    def test_empty_inventory(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            payload = routes._inventory_payload(conn, "new_install")
            assert payload["tokens"] == 0
            assert payload["items"] == []
            assert payload["cosmetics"] == []

    def test_inventory_with_tokens(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            conn.execute(
                "INSERT INTO daily_inventory (install_id, tokens) VALUES (?, ?)",
                ("token_install", 50),
            )
            conn.commit()
            payload = routes._inventory_payload(conn, "token_install")
            assert payload["tokens"] == 50

    def test_inventory_with_cosmetics(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            conn.execute(
                "INSERT INTO daily_inventory (install_id, tokens, cosmetics) VALUES (?, ?, ?)",
                ("cosmetic_install", 0, json.dumps([{"id": "flair_glow", "purchased_at": "2026-04-24"}])),
            )
            conn.commit()
            payload = routes._inventory_payload(conn, "cosmetic_install")
            assert len(payload["cosmetics"]) == 1
            assert payload["cosmetics"][0]["id"] == "flair_glow"

    def test_inventory_with_equipped(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            conn = routes._get_conn()
            conn.execute(
                "INSERT INTO daily_inventory (install_id, tokens, equipped) VALUES (?, ?, ?)",
                ("equipped_install", 0, json.dumps({"flair": "flair_glow"})),
            )
            conn.commit()
            payload = routes._inventory_payload(conn, "equipped_install")
            assert payload["equipped"]["flair"] == "flair_glow"


class TestShopBuy:
    """Integration tests for POST /shop/buy endpoint."""

    def test_buy_cosmetic_already_owned(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            conn = routes._get_conn()
            conn.execute(
                "INSERT INTO daily_inventory (install_id, tokens, cosmetics) VALUES (?, ?, ?)",
                ("owned_test", 50, json.dumps([{"id": "flair_glow", "purchased_at": "2026-04-24"}])),
            )
            conn.commit()
            resp = client.post(
                "/api/plugins/the_daily/shop/buy",
                json={"item_id": "flair_glow"},
                headers={"X-Daily-Install-Id": "owned_test"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["error"] == "Already owned"

    def test_buy_consumable_success(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            conn = routes._get_conn()
            conn.execute(
                "INSERT INTO daily_inventory (install_id, tokens) VALUES (?, ?)",
                ("consume_test", 50),
            )
            conn.commit()
            resp = client.post(
                "/api/plugins/the_daily/shop/buy",
                json={"item_id": "boss_reroll"},
                headers={"X-Daily-Install-Id": "consume_test"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["item_id"] == "boss_reroll"
            assert data["new_balance"] == 42
            assert "effect" in data
            row = conn.execute("SELECT tokens FROM daily_inventory WHERE install_id = ?", ("consume_test",)).fetchone()
            assert row[0] == 42

    def test_buy_insufficient_tokens(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            conn = routes._get_conn()
            conn.execute(
                "INSERT INTO daily_inventory (install_id, tokens) VALUES (?, ?)",
                ("poor_test", 5),
            )
            conn.commit()
            resp = client.post(
                "/api/plugins/the_daily/shop/buy",
                json={"item_id": "flair_glow"},
                headers={"X-Daily-Install-Id": "poor_test"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["error"] == "Insufficient tokens"

    def test_buy_unknown_item(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            resp = client.post(
                "/api/plugins/the_daily/shop/buy",
                json={"item_id": "fake_item"},
                headers={"X-Daily-Install-Id": "unknown_test"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["error"] == "Unknown item"

    def test_buy_without_install_id(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            resp = client.post(
                "/api/plugins/the_daily/shop/buy",
                json={"item_id": "flair_glow"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["error"] == "install_id required"


class TestShopRefund:
    """Integration tests for POST /shop/refund endpoint."""

    def test_refund_within_window(self):
        now = datetime.now(timezone.utc)
        past = (now - timedelta(seconds=30)).isoformat()
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base, today="2026-04-24")
            client = TestClient(app)
            conn = routes._get_conn()
            conn.execute(
                "INSERT INTO daily_inventory (install_id, tokens, cosmetics) VALUES (?, ?, ?)",
                ("refund_test", 15, json.dumps([{"id": "flair_glow", "purchased_at": past}])),
            )
            conn.execute(
                "INSERT INTO daily_purchases (install_id, item_id, purchased_at) VALUES (?, ?, ?)",
                ("refund_test", "flair_glow", past),
            )
            conn.commit()
            resp = client.post(
                "/api/plugins/the_daily/shop/refund",
                json={"item_id": "flair_glow"},
                headers={"X-Daily-Install-Id": "refund_test"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["refunded"] is True
            row = conn.execute("SELECT tokens, cosmetics FROM daily_inventory WHERE install_id = ?", ("refund_test",)).fetchone()
            assert row[0] == 30
            cosmetics = json.loads(row[1])
            assert len(cosmetics) == 0

    def test_refund_expired(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base, today="2026-04-25")
            client = TestClient(app)
            conn = routes._get_conn()
            conn.execute(
                "INSERT INTO daily_inventory (install_id, tokens, cosmetics) VALUES (?, ?, ?)",
                ("expired_test", 15, json.dumps([{"id": "flair_glow", "purchased_at": "2026-04-24T12:00:00+00:00"}])),
            )
            conn.execute(
                "INSERT INTO daily_purchases (install_id, item_id, purchased_at) VALUES (?, ?, ?)",
                ("expired_test", "flair_glow", "2026-04-24T12:00:00+00:00"),
            )
            conn.commit()
            resp = client.post(
                "/api/plugins/the_daily/shop/refund",
                json={"item_id": "flair_glow"},
                headers={"X-Daily-Install-Id": "expired_test"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["error"] == "Refund window expired"

    def test_refund_not_owned(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app, routes = _make_app_with_routes(base)
            client = TestClient(app)
            conn = routes._get_conn()
            conn.execute(
                "INSERT INTO daily_inventory (install_id, tokens, cosmetics) VALUES (?, ?, ?)",
                ("not_owned_test", 15, json.dumps([])),
            )
            conn.commit()
            resp = client.post(
                "/api/plugins/the_daily/shop/refund",
                json={"item_id": "flair_glow"},
                headers={"X-Daily-Install-Id": "not_owned_test"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["error"] == "Item not owned"
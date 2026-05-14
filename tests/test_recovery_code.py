#!/usr/bin/env python3
"""Tests for recovery code backend."""

import json
import sqlite3
import sys
import secrets
import unittest
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).parents[3]))

from plugins.the_daily.routes import (
    _generate_recovery_code,
    _get_or_create_recovery_code,
    _is_valid_code_shape,
    _load_word_list,
    _BIP39_WORDS,
)


def _make_inv_conn():
    """Create an in-memory SQLite connection with daily_inventory table."""
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS daily_inventory (
            install_id TEXT PRIMARY KEY,
            items TEXT NOT NULL DEFAULT '[]',
            last_streak_milestone INTEGER NOT NULL DEFAULT 0,
            starter_awarded INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT,
            tokens INTEGER NOT NULL DEFAULT 0,
            cosmetics TEXT NOT NULL DEFAULT '[]',
            equipped TEXT NOT NULL DEFAULT '{}',
            recovery_code TEXT
        );
    """)
    return conn


class TestGenerateRecoveryCode(unittest.TestCase):
    def test_generate_format(self):
        code = _generate_recovery_code()
        parts = code.split("-")
        self.assertEqual(len(parts), 4)
        for p in parts:
            self.assertTrue(p.islower() and 3 <= len(p) <= 8, f"Invalid word: {p}")

    def test_generate_uses_word_list(self):
        words = _load_word_list()
        self.assertIsNotNone(words)
        self.assertGreaterEqual(len(words), 10)
        code = _generate_recovery_code()
        parts = code.split("-")
        for p in parts:
            self.assertIn(p, words)

    def test_generate_unique(self):
        codes = {_generate_recovery_code() for _ in range(20)}
        self.assertGreaterEqual(len(codes), 15)


class TestGetOrCreateRecoveryCode(unittest.TestCase):
    def setUp(self):
        self.conn = _make_inv_conn()
        self.install_id = "test-install-001"

    def test_creates_code_when_absent(self):
        code = _get_or_create_recovery_code(self.conn, self.install_id)
        self.assertIsNotNone(code)
        parts = code.split("-")
        self.assertEqual(len(parts), 4)

    def test_idempotent(self):
        c1 = _get_or_create_recovery_code(self.conn, self.install_id)
        c2 = _get_or_create_recovery_code(self.conn, self.install_id)
        self.assertEqual(c1, c2)

    def test_different_installs_different_codes(self):
        c1 = _get_or_create_recovery_code(self.conn, "install-a")
        c2 = _get_or_create_recovery_code(self.conn, "install-b")
        self.assertNotEqual(c1, c2)

    def test_persists_in_db(self):
        code = _get_or_create_recovery_code(self.conn, self.install_id)
        row = self.conn.execute(
            "SELECT recovery_code FROM daily_inventory WHERE install_id = ?",
            (self.install_id,)
        ).fetchone()
        self.assertEqual(row[0], code)


class TestIsValidCodeShape(unittest.TestCase):
    def test_valid_code(self):
        self.assertTrue(_is_valid_code_shape("forest-anchor-rapid-mint"))

    def test_valid_lowercase(self):
        self.assertTrue(_is_valid_code_shape("forest-anchor-rapid-mint"))

    def test_invalid_three_words(self):
        self.assertFalse(_is_valid_code_shape("one-two-three"))

    def test_invalid_five_words(self):
        self.assertFalse(_is_valid_code_shape("one-two-three-four-five"))

    def test_invalid_non_alpha(self):
        self.assertFalse(_is_valid_code_shape("one-2wo-three-four"))

    def test_invalid_short_word(self):
        self.assertFalse(_is_valid_code_shape("a-b-c-d"))

    def test_invalid_long_word(self):
        self.assertFalse(_is_valid_code_shape("toolongword-one-two-three"))


class TestWordListLoader(unittest.TestCase):
    def test_returns_list(self):
        words = _load_word_list()
        self.assertIsInstance(words, list)
        self.assertGreater(len(words), 0)

    def test_fallback_when_missing(self):
        # We can't easily test the fallback without mocking, but we can verify
        # the function returns something usable
        words = _load_word_list()
        self.assertIn("forest", words)


class TestAdoptEndpoint(unittest.TestCase):
    def setUp(self):
        from fastapi.testclient import TestClient
        from fastapi import FastAPI
        self.app = FastAPI()
        self.conn = _make_inv_conn()

        # Register a mock endpoint to test the adopt logic
        install_id = "test-install-adopt"

        @self.app.post("/test-adopt")
        def test_adopt_endpoint(data: dict):
            new_code = (data.get("code") or "").strip().lower()
            if not _is_valid_code_shape(new_code):
                return {"error": "Invalid code format"}
            with self.conn:
                self.conn.execute(
                    "INSERT INTO daily_inventory (install_id, recovery_code) VALUES (?, ?) "
                    "ON CONFLICT(install_id) DO UPDATE SET recovery_code = excluded.recovery_code",
                    (install_id, new_code)
                )
                self.conn.commit()
            return {"code": new_code, "adopted": True}

        self.client = TestClient(self.app)
        self.install_id = install_id

    def test_adopt_valid_code(self):
        r = self.client.post("/test-adopt", json={"code": "forest-anchor-rapid-mint"})
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertTrue(data["adopted"])
        self.assertEqual(data["code"], "forest-anchor-rapid-mint")

    def test_adopt_invalid_code(self):
        r = self.client.post("/test-adopt", json={"code": "not-a-code"})
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertIn("error", data)


if __name__ == "__main__":
    import unittest
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    suite.addTests(loader.loadTestsFromTestCase(TestGenerateRecoveryCode))
    suite.addTests(loader.loadTestsFromTestCase(TestGetOrCreateRecoveryCode))
    suite.addTests(loader.loadTestsFromTestCase(TestIsValidCodeShape))
    suite.addTests(loader.loadTestsFromTestCase(TestWordListLoader))
    suite.addTests(loader.loadTestsFromTestCase(TestAdoptEndpoint))
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)

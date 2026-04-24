#!/usr/bin/env python3
"""Test suite for The Daily plugin."""

import json
import sys
import sqlite3
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parents[3]))

from plugins.the_daily.routes import (
    DEFAULT_SONG_COUNT,
    MODIFIERS,
    POOL_URL,
    _EPOCH,
    _date_seed,
    _day_name,
    _pick_modifier,
    _select_songs,
    _load_pool,
    _get_conn,
    _identity_candidates,
    _select_composite,
    _select_sequence,
    _select_structural,
    _find_locally,
    _compute_streak,
)


POOL_FILE = Path(__file__).parent.parent / "songs_pool.json"


def _load_test_pool():
    if not POOL_FILE.exists():
        return None
    with open(POOL_FILE) as f:
        pool = json.load(f)
    return [s for s in pool
            if len((s.get("artist") or "").strip()) >= 2
            and len((s.get("title") or "").strip()) >= 2
            and "full album" not in (s.get("title") or "").lower()]


class TestDateSeed(unittest.TestCase):
    def test_seed_consistency(self):
        d = "2026-04-22"
        seed1 = _date_seed(d)
        seed2 = _date_seed(d)
        self.assertEqual(seed1, seed2)
        self.assertEqual(len(seed1), 6)

    def test_seed_changes_daily(self):
        d1 = "2026-04-22"
        d2 = "2026-04-23"
        self.assertNotEqual(_date_seed(d1), _date_seed(d2))


class TestModifierSelection(unittest.TestCase):
    def setUp(self):
        self.pool = _load_test_pool()
        if not self.pool:
            self.skipTest("Pool file not available")

    def test_pick_modifier_deterministic(self):
        d = "2026-04-22"
        m1 = _pick_modifier(d)
        m2 = _pick_modifier(d)
        self.assertEqual(m1, m2)

    def test_pick_modifier_is_valid_key(self):
        d = "2026-04-23"
        mod_id = _pick_modifier(d)
        self.assertIn(mod_id, MODIFIERS)

    def test_all_modifiers_valid_types(self):
        valid_types = {"filter", "identity", "composite", "ordering", "sequence", "structural", "meta", "ui"}
        for mod_id, mod in MODIFIERS.items():
            self.assertIn(mod["type"], valid_types, f"{mod_id} has invalid type")


class TestModifierFunctionality(unittest.TestCase):
    def setUp(self):
        self.pool = _load_test_pool()
        if not self.pool or len(self.pool) < 10:
            self.skipTest("Pool file not available or too small")

    def test_filter_modifiers(self):
        filter_mods = [k for k, m in MODIFIERS.items() if m["type"] == "filter"]
        for mod_id in filter_mods[:5]:
            mod = MODIFIERS[mod_id]
            fn = mod.get("fn")
            if not fn:
                continue
            matches = [s for s in self.pool if fn(s)]
            if matches:
                self.assertTrue(any(fn(s) for s in matches))

    def test_identity_modifiers(self):
        identity_mods = [k for k, m in MODIFIERS.items() if m["type"] == "identity"]
        for mod_id in identity_mods[:3]:
            mod = MODIFIERS[mod_id]
            key = mod.get("key")
            if not key:
                continue
            candidates, fallback = _identity_candidates("2026-04-22", self.pool, key, 5, mod.get("min_pool"))
            if not fallback:
                self.assertGreaterEqual(len(candidates), 5)


class TestSelectSongs(unittest.TestCase):
    def setUp(self):
        self.pool = _load_test_pool()
        if not self.pool:
            self.skipTest("Pool file not available")

    def test_select_returns_five_songs(self):
        d = "2026-04-22"
        for _ in range(10):
            mod_id = _pick_modifier(d)
            songs, count, fallback = _select_songs(d, mod_id, self.pool)
            self.assertEqual(count, DEFAULT_SONG_COUNT)
            self.assertEqual(len(songs), DEFAULT_SONG_COUNT)
            self.assertEqual(len({s["cf_id"] for s in songs}), DEFAULT_SONG_COUNT)

    def test_no_duplicate_cf_ids(self):
        d = "2026-04-22"
        mod_id = _pick_modifier(d)
        songs, _, _ = _select_songs(d, mod_id, self.pool)
        cf_ids = [s["cf_id"] for s in songs]
        self.assertEqual(len(cf_ids), len(set(cf_ids)))


class TestDayName(unittest.TestCase):
    def test_daily_number(self):
        d = "2026-04-22"
        songs = [{"artist": "Test", "title": "Test"}]
        name = _day_name(d, "e_standard", songs)
        self.assertEqual(name, "Daily #1")

    def test_daily_number_increments(self):
        songs = [{"artist": "Test", "title": "Test"}]
        d1 = _day_name("2026-04-22", "e_standard", songs)
        d2 = _day_name("2026-04-23", "e_standard", songs)
        self.assertEqual(d1, "Daily #1")
        self.assertEqual(d2, "Daily #2")

    def test_identity_decade(self):
        songs = [{"artist": "Test", "title": "Test", "year": "1985"}]
        name = _day_name("2026-04-22", "decade_night", songs)
        self.assertEqual(name, "The 1980s")

    def test_identity_artist(self):
        songs = [{"artist": "Metallica", "title": "One", "year": "1988"}]
        name = _day_name("2026-04-22", "artist_takeover", songs)
        self.assertEqual(name, "Metallica")


class TestEpoch(unittest.TestCase):
    def test_epoch_date(self):
        self.assertEqual(_EPOCH, date(2026, 4, 22))

    def test_day_number_alignment(self):
        test_date = date(2026, 4, 22)
        day_num = (test_date - _EPOCH).days + 1
        self.assertEqual(day_num, 1)


class TestPoolLoading(unittest.TestCase):
    def test_pool_file_exists(self):
        self.assertTrue(POOL_FILE.exists(), "songs_pool.json not found")

    def test_pool_minimum_size(self):
        pool = _load_test_pool()
        self.assertGreaterEqual(len(pool), 100, "Pool should have at least 100 songs")

    def test_pool_filtering(self):
        with open(POOL_FILE) as f:
            raw = json.load(f)
        filtered = [s for s in raw
                   if len((s.get("artist") or "").strip()) >= 2
                   and len((s.get("title") or "").strip()) >= 2
                   and "full album" not in (s.get("title") or "").lower()]
        self.assertLess(len(filtered), len(raw))


class TestCompositeSelect(unittest.TestCase):
    def setUp(self):
        self.pool = _load_test_pool()
        if not self.pool:
            self.skipTest("Pool file not available")

    def test_discography(self):
        if "discography" not in MODIFIERS:
            self.skipTest("discography not in modifiers")
        songs, count, fallback = _select_composite("2026-04-22", "discography", self.pool, 5)
        self.assertGreaterEqual(count, 5)

    def test_time_machine(self):
        if "time_machine" not in MODIFIERS:
            self.skipTest("time_machine not in modifiers")
        songs, count, fallback = _select_composite("2026-04-22", "time_machine", self.pool, 5)
        self.assertGreaterEqual(count, 5)


class TestSequenceSelect(unittest.TestCase):
    def setUp(self):
        self.pool = _load_test_pool()
        if not self.pool:
            self.skipTest("Pool file not available")

    def test_title_chain(self):
        if "title_chain" not in MODIFIERS:
            self.skipTest("title_chain not in modifiers")
        songs, count, fallback = _select_sequence("2026-04-22", "title_chain", self.pool, 5)
        self.assertGreaterEqual(count, 5)

    def test_palette_swap(self):
        if "palette_swap" not in MODIFIERS:
            self.skipTest("palette_swap not in modifiers")
        songs, count, fallback = _select_sequence("2026-04-22", "palette_swap", self.pool, 5)
        self.assertGreaterEqual(count, 5)


class TestStructuralSelect(unittest.TestCase):
    def setUp(self):
        self.pool = _load_test_pool()
        if not self.pool:
            self.skipTest("Pool file not available")

    def test_bookends(self):
        if "bookends" not in MODIFIERS:
            self.skipTest("bookends not in modifiers")
        songs, count, fallback = _select_structural("2026-04-22", "bookends", self.pool, 5)
        if not fallback:
            self.assertEqual(songs[0]["artist"], songs[-1]["artist"])

    def test_rival_camps(self):
        if "rival_camps" not in MODIFIERS:
            self.skipTest("rival_camps not in modifiers")
        songs, count, fallback = _select_structural("2026-04-22", "rival_camps", self.pool, 5)
        if not fallback:
            artists = [s["artist"] for s in songs]
            unique = set(artists)
            self.assertEqual(len(unique), 2)


class TestLocalMatching(unittest.TestCase):
    def test_find_locally_no_match(self):
        mock_meta_db = MagicMock()
        mock_meta_db.conn.execute.return_value.fetchone.return_value = None
        song = {"artist": "UnknownArtist", "title": "UnknownSong"}
        result = _find_locally(mock_meta_db, song)
        self.assertIsNone(result)

    def test_find_locally_match(self):
        mock_meta_db = MagicMock()
        mock_meta_db.conn.execute.return_value.fetchone.return_value = ("song.pkg",)
        song = {"artist": "Metallica", "title": "One"}
        result = _find_locally(mock_meta_db, song)
        self.assertEqual(result, "song.pkg")


class TestStreak(unittest.TestCase):
    def setUp(self):
        self.temp_db = Path(__file__).parent / "test_temp.db"
        self.conn = sqlite3.connect(str(self.temp_db))
        self.conn.executescript("""
            CREATE TABLE daily_setlists (
                date TEXT PRIMARY KEY,
                day_name TEXT,
                modifier TEXT,
                songs TEXT,
                song_count INTEGER
            );
            CREATE TABLE daily_completions (
                date TEXT NOT NULL,
                cf_id INTEGER NOT NULL,
                completed_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (date, cf_id)
            );
        """)

    def tearDown(self):
        self.conn.close()
        if self.temp_db.exists():
            self.temp_db.unlink()

    def test_streak_zero_when_empty(self):
        streak = _compute_streak(self.conn, "2026-04-22")
        self.assertEqual(streak, 0)

    def test_streak_increments_with_completions(self):
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        self.conn.execute(
            "INSERT INTO daily_setlists (date, day_name, modifier, songs, song_count) VALUES (?, ?, ?, ?, ?)",
            (yesterday, "Daily #1", "e_standard", "[]", 5)
        )
        for cf_id in range(1, 6):
            self.conn.execute(
                "INSERT INTO daily_completions (date, cf_id) VALUES (?, ?)",
                (yesterday, cf_id)
            )
        self.conn.commit()
        streak = _compute_streak(self.conn, date.today().isoformat())
        self.assertGreaterEqual(streak, 1)


class TestPreviewScript(unittest.TestCase):
    def test_preview_imports(self):
        from plugins.the_daily import preview
        self.assertTrue(hasattr(preview, "_simulate_day"))


def run_tests():
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    
    suite.addTests(loader.loadTestsFromTestCase(TestDateSeed))
    suite.addTests(loader.loadTestsFromTestCase(TestModifierSelection))
    suite.addTests(loader.loadTestsFromTestCase(TestModifierFunctionality))
    suite.addTests(loader.loadTestsFromTestCase(TestSelectSongs))
    suite.addTests(loader.loadTestsFromTestCase(TestDayName))
    suite.addTests(loader.loadTestsFromTestCase(TestEpoch))
    suite.addTests(loader.loadTestsFromTestCase(TestPoolLoading))
    suite.addTests(loader.loadTestsFromTestCase(TestCompositeSelect))
    suite.addTests(loader.loadTestsFromTestCase(TestSequenceSelect))
    suite.addTests(loader.loadTestsFromTestCase(TestStructuralSelect))
    suite.addTests(loader.loadTestsFromTestCase(TestLocalMatching))
    suite.addTests(loader.loadTestsFromTestCase(TestStreak))
    suite.addTests(loader.loadTestsFromTestCase(TestPreviewScript))
    
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(run_tests())
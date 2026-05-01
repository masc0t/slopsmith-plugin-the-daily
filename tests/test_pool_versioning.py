#!/usr/bin/env python3
"""Tests for pool versioning (manifest + stamp + latest-leq) and UTC date."""

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[3]))

from plugins.the_daily import routes
from plugins.the_daily.routes import (
    _latest_leq_stamp,
    _get_pool_stamp,
    _load_pool,
)


def _init_tmp_db():
    """Point routes at a fresh tmp DB and force connection reset."""
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    routes._db_path = tmp.name
    routes._conn = None
    routes._get_conn()  # creates schema
    return tmp.name


class TestLatestLeqStamp(unittest.TestCase):
    def test_empty_stamps_returns_none(self):
        self.assertIsNone(_latest_leq_stamp([], date(2026, 5, 1)))

    def test_all_stamps_after_target_returns_none(self):
        stamps = ["2026-05-10", "2026-05-15"]
        self.assertIsNone(_latest_leq_stamp(stamps, date(2026, 5, 1)))

    def test_all_stamps_before_target_returns_max(self):
        stamps = ["2026-04-15", "2026-04-22", "2026-04-30"]
        self.assertEqual(_latest_leq_stamp(stamps, date(2026, 5, 1)), "2026-04-30")

    def test_exact_match_returns_match(self):
        stamps = ["2026-04-15", "2026-05-01", "2026-05-10"]
        self.assertEqual(_latest_leq_stamp(stamps, date(2026, 5, 1)), "2026-05-01")

    def test_picks_largest_leq(self):
        stamps = ["2026-04-15", "2026-04-22", "2026-05-10"]
        self.assertEqual(_latest_leq_stamp(stamps, date(2026, 5, 1)), "2026-04-22")

    def test_unsorted_input_still_correct(self):
        stamps = ["2026-05-15", "2026-04-15", "2026-04-30", "2026-05-10"]
        self.assertEqual(_latest_leq_stamp(stamps, date(2026, 5, 5)), "2026-04-30")


class TestPoolStampResolution(unittest.TestCase):
    def setUp(self):
        _init_tmp_db()

    def test_uses_manifest_when_available(self):
        with patch.object(routes, "_fetch_manifest", return_value=["2026-04-22", "2026-05-01"]):
            stamp = _get_pool_stamp("2026-05-05")
            self.assertEqual(stamp, "2026-05-01")

    def test_returns_none_when_no_stamps_available(self):
        with patch.object(routes, "_fetch_manifest", return_value=None):
            stamp = _get_pool_stamp("2026-05-01")
            self.assertIsNone(stamp)

    def test_returns_none_when_target_predates_all_stamps(self):
        with patch.object(routes, "_fetch_manifest", return_value=None):
            stamp = _get_pool_stamp("2026-04-01")
            self.assertIsNone(stamp)


class TestLoadPoolHardFail(unittest.TestCase):
    """When manifest+pool fetch fails, _load_pool raises an error."""

    def setUp(self):
        _init_tmp_db()

    def test_raises_when_no_pool_available(self):
        plugin_dir = Path(__file__).parent.parent
        with patch.object(routes, "_fetch_manifest", return_value=None):
            with self.assertRaises(RuntimeError):
                _load_pool("2026-05-01", plugin_dir)

    def test_raises_when_fetch_fails(self):
        plugin_dir = Path(__file__).parent.parent
        with patch.object(routes, "_fetch_manifest", return_value=["2026-99-99"]):
            with patch.object(routes, "_fetch_pool_by_stamp", return_value=None):
                with self.assertRaises(RuntimeError):
                    _load_pool("2026-05-01", plugin_dir)


class TestSchemaPoolStamp(unittest.TestCase):
    def setUp(self):
        _init_tmp_db()

    def test_pool_cache_keyed_by_stamp(self):
        conn = routes._get_conn()
        cols = {r[1] for r in conn.execute("PRAGMA table_info(pool_cache)").fetchall()}
        self.assertIn("pool_stamp", cols)
        self.assertIn("fetched_at", cols)

    def test_daily_setlists_has_pool_stamp(self):
        conn = routes._get_conn()
        cols = {r[1] for r in conn.execute("PRAGMA table_info(daily_setlists)").fetchall()}
        self.assertIn("pool_stamp", cols)


class TestUTCDate(unittest.TestCase):
    def test_get_today_uses_utc(self):
        # Strip env override and verify _get_today returns a date object derived from UTC.
        os.environ.pop("THE_DAILY_TEST_TODAY", None)
        result = routes._get_today()
        expected = datetime.utcnow().date()
        # Within a 1-second tolerance (could roll midnight mid-test).
        self.assertIn(result, (expected, datetime.utcnow().date()))

    def test_get_today_respects_env_override(self):
        os.environ["THE_DAILY_TEST_TODAY"] = "2026-06-15"
        try:
            self.assertEqual(routes._get_today(), date(2026, 6, 15))
        finally:
            os.environ.pop("THE_DAILY_TEST_TODAY", None)


class TestPoolStampPersisted(unittest.TestCase):
    """daily_setlists row should record pool_stamp when generated."""

    def setUp(self):
        _init_tmp_db()

    def test_pool_cache_writes_include_fetched_at(self):
        # Simulate a pool fetch via mocked manifest+fetch, then verify cache row.
        plugin_dir = Path(__file__).parent.parent
        with patch.object(routes, "_fetch_manifest", return_value=["2026-05-01"]):
            with patch.object(routes, "_fetch_pool_by_stamp", return_value=[{"artist": "Test", "title": "Test"}]):
                _load_pool("2026-05-01", plugin_dir)

        conn = routes._get_conn()
        rows = conn.execute(
            "SELECT pool_stamp, fetched_at FROM pool_cache"
        ).fetchall()
        self.assertGreater(len(rows), 0)
        for stamp, fetched_at in rows:
            self.assertTrue(stamp)
            self.assertTrue(fetched_at)


if __name__ == "__main__":
    unittest.main()

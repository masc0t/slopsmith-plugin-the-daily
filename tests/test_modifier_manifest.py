#!/usr/bin/env python3
"""Tests for modifier manifest loading (fetch, cache, version gate)."""

import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).parents[3]))

from plugins.the_daily import routes
from plugins.the_daily.routes import (
    _load_modifier_manifest,
    _resolve_modifier_stamp,
    _check_version_gate,
    _PLUGIN_VERSION,
)


def _init_tmp_db():
    """Point routes at a fresh tmp DB and force connection reset."""
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    routes._db_path = tmp.name
    routes._conn = None
    routes._get_conn()
    return tmp.name


class TestResolveModifierStamp(unittest.TestCase):
    def test_exact_match(self):
        manifest = {
            "stamps": [
                {"date": "2026-04-22", "min_plugin_version": None, "active": []},
                {"date": "2026-05-01", "min_plugin_version": None, "active": []},
            ]
        }
        stamp = _resolve_modifier_stamp(manifest, "2026-05-01")
        self.assertEqual(stamp["date"], "2026-05-01")

    def test_date_between_stamps(self):
        manifest = {
            "stamps": [
                {"date": "2026-04-22", "min_plugin_version": None, "active": []},
                {"date": "2026-05-01", "min_plugin_version": None, "active": []},
                {"date": "2026-05-15", "min_plugin_version": None, "active": []},
            ]
        }
        stamp = _resolve_modifier_stamp(manifest, "2026-05-10")
        self.assertEqual(stamp["date"], "2026-05-01")

    def test_date_before_all_stamps(self):
        manifest = {
            "stamps": [
                {"date": "2026-05-01", "min_plugin_version": None, "active": []},
                {"date": "2026-05-15", "min_plugin_version": None, "active": []},
            ]
        }
        with self.assertRaises(RuntimeError) as cm:
            _resolve_modifier_stamp(manifest, "2026-04-20")
        self.assertIn("No modifier stamp applicable", str(cm.exception))

    def test_multiple_stamps_uses_latest(self):
        manifest = {
            "stamps": [
                {"date": "2026-04-22", "min_plugin_version": None, "active": []},
                {"date": "2026-04-23", "min_plugin_version": None, "active": []},
                {"date": "2026-04-24", "min_plugin_version": None, "active": []},
            ]
        }
        stamp = _resolve_modifier_stamp(manifest, "2026-04-24")
        self.assertEqual(stamp["date"], "2026-04-24")


class TestCheckVersionGate(unittest.TestCase):
    def setUp(self):
        self._original_version = routes._PLUGIN_VERSION

    def tearDown(self):
        routes._PLUGIN_VERSION = self._original_version

    def test_no_min_version_passes(self):
        stamp = {"min_plugin_version": None, "active": []}
        _check_version_gate(stamp)

    def test_exact_version_passes(self):
        routes._PLUGIN_VERSION = "1.0.0"
        stamp = {"min_plugin_version": "1.0.0", "active": []}
        _check_version_gate(stamp)

    def test_newer_version_passes(self):
        routes._PLUGIN_VERSION = "2.0.0"
        stamp = {"min_plugin_version": "1.0.0", "active": []}
        _check_version_gate(stamp)

    def test_older_version_raises(self):
        routes._PLUGIN_VERSION = "1.0.0"
        stamp = {"min_plugin_version": "2.0.0", "active": []}
        with self.assertRaises(RuntimeError) as cm:
            _check_version_gate(stamp)
        self.assertEqual(str(cm.exception), "update_required:2.0.0")

    def test_missing_version_field_passes(self):
        stamp = {"active": []}
        _check_version_gate(stamp)


class TestLoadModifierManifest(unittest.TestCase):
    def setUp(self):
        self._db_path = _init_tmp_db()
        self._original_fetch = routes._fetch_modifier_manifest

    def tearDown(self):
        routes._fetch_modifier_manifest = self._original_fetch
        routes._conn = None
        routes._db_path = None
        import os
        try:
            os.unlink(self._db_path)
        except PermissionError:
            pass

    def test_returns_cached_row(self):
        mock_manifest = {"stamps": [{"date": "2026-04-22", "min_plugin_version": None, "active": []}]}
        routes._fetch_modifier_manifest = lambda: mock_manifest

        result1 = _load_modifier_manifest("2026-04-22")
        self.assertEqual(result1, mock_manifest)

        routes._fetch_modifier_manifest = unittest.mock.MagicMock(side_effect=Exception("should not be called"))
        result2 = _load_modifier_manifest("2026-04-22")
        self.assertEqual(result2, mock_manifest)

    def test_offline_raises(self):
        routes._fetch_modifier_manifest = lambda: None
        with self.assertRaises(RuntimeError) as cm:
            _load_modifier_manifest("2026-04-22")
        self.assertEqual(str(cm.exception), "offline")

    def test_fetches_on_miss(self):
        mock_manifest = {"stamps": [{"date": "2026-05-01", "min_plugin_version": None, "active": []}]}
        fetch_calls = []

        def mock_fetch():
            fetch_calls.append(1)
            return mock_manifest

        routes._fetch_modifier_manifest = mock_fetch
        result = _load_modifier_manifest("2026-05-01")
        self.assertEqual(len(fetch_calls), 1)
        self.assertEqual(result, mock_manifest)


if __name__ == "__main__":
    unittest.main()
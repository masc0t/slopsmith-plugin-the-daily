#!/usr/bin/env python3
"""Integration tests for The Daily plugin routes."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

from fastapi import FastAPI
from fastapi.testclient import TestClient
from plugins.the_daily import routes

from _routes_test_helper import make_context


class TestEndpointRegistration(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = FastAPI()
        self.mock_context = make_context(Path(self.tmp.name), MagicMock())
        routes.setup(self.app, self.mock_context)
        self.client = TestClient(self.app)

    def tearDown(self):
        from plugins.the_daily.routes import _close_conn
        _close_conn()
        self.tmp.cleanup()

    def _route_paths(self):
        return [r.path for r in self.app.routes]

    def test_today_endpoint_registered(self):
        """Verify /today endpoint is registered."""
        self.assertIn("/api/plugins/the_daily/today", self._route_paths())

    def test_setlist_by_date_endpoint_registered(self):
        """Verify /setlist/{date} endpoint is registered."""
        paths = self._route_paths()
        self.assertTrue(
            any("/api/plugins/the_daily/setlist/" in p for p in paths),
            f"No /setlist/... route found in {paths}",
        )


def run_tests():
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    suite.addTests(loader.loadTestsFromTestCase(TestEndpointRegistration))
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(run_tests())
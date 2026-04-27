#!/usr/bin/env python3
"""
Deterministic map preview generator (MVP).
Produces a small deterministic JSON payload similar to a /today response
for testing the map rendering in the frontend.
"""
import json
from datetime import date

def main():
    today = date.today().isoformat()
    payload = {
        "date": today,
        "day_name": "The Daily Test",
        "day_number": 1,
        "modifier": {"id": "test_mod", "label": "Test Mod", "icon": "🧪", "description": "Deterministic preview"},
        "songs": [
            {"cf_id": 101, "title": "Test Song 1", "artist": "A", "duration": 180, "tuning": "standard"},
            {"cf_id": 102, "title": "Test Song 2", "artist": "B", "duration": 210, "tuning": "standard"},
        ],
        "map": {
            "nodes": [
                {"id": "n1", "type": "forced", "lane": "standard", "col": 0, "row": 0},
                {"id": "n2", "type": "rest", "lane": "standard", "col": 1, "row": 0},
            ],
            "edges": [{"from": "n1", "to": "n2"}],
            "lanes": {"standard": ""}
        },
        "available_node_ids": ["n1", "n2"],
        "cleared_node_ids": [],
        "locked_node_ids": []
    }
    print(json.dumps(payload, indent=2))

if __name__ == '__main__':
    main()

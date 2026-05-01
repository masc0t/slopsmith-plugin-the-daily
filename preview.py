#!/usr/bin/env python3
"""Preview upcoming Daily setlists without touching the database."""

import argparse
import json
import re
import sys
import urllib.request
from datetime import date, timedelta, datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).parents[2]))

from plugins.the_daily.routes import (
    BUNDLED_POOL_STAMP,
    DEFAULT_SONG_COUNT,
    MAP_LANES,
    MANIFEST_URL,
    MODIFIERS_MANIFEST_URL,
    POOL_URL,
    _build_map,
    _EPOCH,
    _date_seed,
    _day_name,
    _fetch_modifier_manifest as _fetch_modifier_manifest_raw,
    _pick_modifier,
    _resolve_modifier_stamp,
    _select_songs,
)

import sqlite3
from plugins.the_daily import routes
_temp_db = sqlite3.connect(":memory:")
_temp_db.execute("CREATE TABLE IF NOT EXISTS daily_completions (date TEXT, cf_id INTEGER, completed_at TEXT)")
_temp_db.execute("CREATE TABLE IF NOT EXISTS daily_setlists (date TEXT PRIMARY KEY, day_name TEXT, modifier TEXT, songs TEXT, song_count INTEGER, map TEXT, fallback INTEGER, lane_paths TEXT, pool_stamp TEXT)")
_temp_db.execute("CREATE TABLE IF NOT EXISTS pool_cache (pool_stamp TEXT PRIMARY KEY, pool TEXT, fetched_at TEXT)")
routes._conn = _temp_db
routes._db_path = ":memory:"

POOL_FILE = Path(__file__).parent / "songs_pool.json"


def _filter_pool(raw):
    return [s for s in raw
            if len((s.get("artist") or "").strip()) >= 2
            and len((s.get("title") or "").strip()) >= 2
            and "full album" not in (s.get("title") or "").lower()]


def _fetch_manifest():
    if not MANIFEST_URL:
        return None
    try:
        req = urllib.request.Request(MANIFEST_URL)
        req.add_header("User-Agent", "slopsmith-daily/1.0-preview")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            return data.get("stamps", [])
    except Exception:
        return None


def _fetch_pool_by_stamp(stamp: str):
    url = POOL_URL.replace("YYYY-MM-DD", stamp)
    try:
        req = urllib.request.Request(url)
        req.add_header("User-Agent", "slopsmith-daily/1.0-preview")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def _latest_leq_stamp(stamps: list, target_date: date):
    valid = [s for s in stamps if s <= target_date.isoformat()]
    if not valid:
        return None
    return max(valid)


def _load_pool(target_date: date = None):
    target_date = target_date or datetime.utcnow().date()

    stamps = _fetch_manifest()

    if stamps:
        stamp = _latest_leq_stamp(stamps, target_date)
        if stamp:
            pool = _fetch_pool_by_stamp(stamp)
            if pool:
                return _filter_pool(pool), stamp

    if POOL_FILE.exists():
        with open(POOL_FILE) as f:
            pool = json.load(f)
        pool = _filter_pool(pool)

        all_stamps = [BUNDLED_POOL_STAMP]
        if stamps:
            all_stamps = stamps + all_stamps
        stamp = _latest_leq_stamp(all_stamps, target_date) or BUNDLED_POOL_STAMP
        return pool, stamp

    return [], None


def _load_active_modifier_set(target_date: date) -> list:
    manifest = _fetch_modifier_manifest_raw()
    if not manifest:
        print("ERROR: Could not fetch modifiers-manifest.json — check network connection")
        sys.exit(1)
    stamp = _resolve_modifier_stamp(manifest, target_date.isoformat())
    return stamp["active"]


def _mod_by_id(active: list, modifier_id: str) -> dict:
    return next((m for m in active if m["id"] == modifier_id), {})


def _simulate_day(d: date, pool: list, pool_stamp: str, history: dict, active: list, map_mode: bool = False) -> tuple:
    date_str = d.isoformat()

    used_cf_ids = set()
    for j in range(1, 15):
        for s in history.get((d - timedelta(days=j)).isoformat(), []):
            used_cf_ids.add(s["cf_id"])
    active_pool = (
        [s for s in pool if s["cf_id"] not in used_cf_ids]
        or pool
    )
    if len(active_pool) < DEFAULT_SONG_COUNT:
        active_pool = pool

    modifier_id = _pick_modifier(date_str, active)

    exclude = None
    if modifier_id == "artist_takeover":
        exclude = set()
        for j in range(1, 15):
            past_songs = history.get((d - timedelta(days=j)).isoformat(), [])
            if past_songs:
                exclude.add((past_songs[0].get("artist") or "").lower())

    map_data = None
    if map_mode:
        map_data, songs, fallback = _build_map(date_str, modifier_id, active_pool, active, exclude=exclude)
        song_count = 1
    else:
        songs, song_count, fallback = _select_songs(date_str, modifier_id, active_pool, active, exclude=exclude)
    mod = _mod_by_id(active, modifier_id)
    day_name = _day_name(date_str, mod, songs)
    return modifier_id, songs, song_count, fallback, day_name, map_data, pool_stamp


def _song_lookup(songs: list) -> dict:
    return {s.get("cf_id"): s for s in songs}


def _song_label(song: dict) -> str:
    artist = (song.get("artist") or "?").strip()
    title = (song.get("title") or "?").strip()
    year = song.get("year") or "????"
    tuning = song.get("tuning") or "—"
    duration = song.get("duration") or ""
    if duration:
        return f"{artist} — {title} ({year}, {tuning}, {duration})"
    return f"{artist} — {title} ({year}, {tuning})"


def _node_label(node: dict, lanes: dict) -> str:
    type_icons = {"forced": "●", "choice": "◇", "mystery": "?", "boss": "♛"}
    lane = node.get("lane")
    lane_icon = lanes.get(lane, "") if lane else ""
    return f"{node['id']}:{type_icons.get(node.get('type'), '●')}{lane_icon}"


def _lane_label(lane_id: str, active: list = ()) -> str:
    if re.match(r"^decade_\d{4}s$", lane_id):
        return lane_id.removeprefix("decade_")
    mod = _mod_by_id(list(active), lane_id)
    return MAP_LANES.get(lane_id, {}).get("label") or mod.get("label") or lane_id


def _print_map_ascii(map_data: dict, songs: list, active: list):
    if not map_data:
        print("  (map generation failed)")
        return

    nodes = sorted(map_data["nodes"], key=lambda n: (n["row"], n["col"], n["id"]))
    rows = {}
    for node in nodes:
        rows.setdefault(node["row"], []).append(node)

    lanes = map_data.get("lanes", {})
    lane_bits = []
    for lane_id, icon in lanes.items():
        label = _lane_label(lane_id, active)
        lane_bits.append(f"{icon} {label}")
    print(f"  Map: {map_data['shape']}  Lanes: {', '.join(lane_bits) if lane_bits else 'none'}")

    for row in sorted(rows):
        ordered = sorted(rows[row], key=lambda n: n["col"])
        labels = [_node_label(node, lanes) for node in ordered]
        print(f"    r{row}: " + "   ".join(f"{label:<8}" for label in labels))
        edge_bits = []
        for node in ordered:
            if node.get("edges"):
                edge_bits.append(f"{node['id']}→{','.join(node['edges'])}")
        if edge_bits:
            print("        " + "  ".join(edge_bits))

    lookup = _song_lookup(songs)
    print("  Nodes:")
    for node in nodes:
        prefix = f"    {_node_label(node, lanes):<8}"
        if node["type"] == "choice":
            options = [_song_label(lookup[cf_id]) for cf_id in node.get("cf_ids", []) if cf_id in lookup]
            print(prefix + " Choice")
            for option in options:
                print(f"      - {option}")
        elif node["type"] == "mystery":
            options = [_song_label(lookup[cf_id]) for cf_id in node.get("cf_pool", []) if cf_id in lookup]
            print(prefix + f" Mystery pool ({len(options)})")
            for option in options:
                print(f"      - {option}")
        else:
            song = lookup.get(node.get("cf_id"))
            print(prefix + (" Boss: " if node["type"] == "boss" else " ") + (_song_label(song) if song else "missing song"))


def _build_snapshot(days: int, start: date, map_mode: bool = False) -> dict:
    """Build a deterministic snapshot of setlists for comparison testing."""
    today = start or datetime.utcnow().date()
    pool, pool_stamp = _load_pool(today)
    active = _load_active_modifier_set(today)
    history: dict[str, list] = {}

    snapshot = {
        "meta": {
            "generated_at": today.isoformat(),
            "days": days,
            "map_mode": map_mode,
            "epoch": _EPOCH.isoformat(),
            "pool_size": len(pool),
            "pool_stamp": pool_stamp,
        },
        "days": []
    }

    for i in range(days):
        d = today + timedelta(days=i)
        date_str = d.isoformat()

        modifier_id, songs, song_count, fallback, day_name, map_data, day_stamp = _simulate_day(d, pool, pool_stamp, history, active, map_mode=map_mode)
        history[date_str] = songs

        day_entry = {
            "date": date_str,
            "day_number": (d - _EPOCH).days + 1,
            "seed": _date_seed(date_str),
            "modifier": modifier_id,
            "modifier_label": _mod_by_id(active, modifier_id).get("label", modifier_id),
            "day_name": day_name,
            "song_count": song_count,
            "fallback": fallback,
            "song_ids": [s["cf_id"] for s in songs[:song_count]],
            "pool_stamp": day_stamp,
        }

        if map_mode and map_data:
            day_entry["map"] = {
                "shape": map_data["shape"],
                "lanes": map_data.get("lanes", {}),
                "node_count": len(map_data["nodes"]),
                "node_ids": [n["id"] for n in map_data["nodes"]],
            }

        snapshot["days"].append(day_entry)

    return snapshot


def run(days: int = 90, compact: bool = False, start: date = None, map_mode: bool = False, snapshot_path: str = None):
    today = start or datetime.utcnow().date()
    pool, pool_stamp = _load_pool(today)
    active = _load_active_modifier_set(today)
    print(f"Pool: {len(pool):,} songs (stamp: {pool_stamp})\n")

    history: dict[str, list] = {}

    modifier_counts: dict[str, int] = {}
    shape_counts: dict[str, int] = {}
    lane_counts: dict[str, int] = {}
    fallback_days: list[str] = []

    for i in range(days):
        d = today + timedelta(days=i)
        date_str = d.isoformat()

        modifier_id, songs, song_count, fallback, day_name, map_data, _ = _simulate_day(d, pool, pool_stamp, history, active, map_mode=map_mode)
        history[date_str] = songs
        modifier_counts[modifier_id] = modifier_counts.get(modifier_id, 0) + 1
        if map_mode and map_data:
            shape_counts[map_data["shape"]] = shape_counts.get(map_data["shape"],0) + 1
            for lane_id in map_data.get("lanes", {}):
                lane_counts[lane_id] = lane_counts.get(lane_id, 0) + 1

        mod = _mod_by_id(active, modifier_id)
        day_number = (d - _EPOCH).days + 1
        warn = "  ⚠ FALLBACK" if fallback else ""
        seed = _date_seed(date_str)

        if compact:
            map_bits = f"  {map_data['shape']:<10} {len(map_data['nodes']):>2} nodes" if map_mode and map_data else ""
            print(f"#{day_number:>4}  {date_str}  {seed}  {mod['icon']} {mod['label']:<24}  {day_name}{map_bits}{warn}")
        else:
            print(f"{'─' * 72}")
            print(f"Day #{day_number}  {date_str}  {seed}  {mod['icon']} {mod['label']}  —  {day_name}{warn}")
            if map_mode:
                _print_map_ascii(map_data, songs, active)
            else:
                for s in songs:
                    year = s.get("year") or "????"
                    tuning = s.get("tuning") or "—"
                    album = s.get("album") or ""
                    print(f"  • {s['artist']:<32}  {s['title']:<36}  {year}  {tuning}")
                    if album:
                        print(f"    {'':32}  {album}")

        if fallback:
            fallback_days.append(f"#{day_number} {date_str} ({mod['label']})")

    print(f"\n{'═' * 72}")
    print(f"Summary — {days} days from {today}")
    print(f"  Modifiers used:")
    for mid, count in sorted(modifier_counts.items(), key=lambda x: -x[1]):
        mod = _mod_by_id(active, mid)
        print(f"    {mod['icon']} {mod['label']:<24}  {count:>3}x")
    if map_mode:
        print(f"\n  Map shapes:")
        for shape, count in sorted(shape_counts.items(), key=lambda x: (-x[1], x[0])):
            print(f"    {shape:<24}  {count:>3}x")
        print(f"\n  Lanes:")
        for lane_id, count in sorted(lane_counts.items(), key=lambda x: (-x[1], x[0])):
            icon = MAP_LANES.get(lane_id, {}).get("icon") or _mod_by_id(active, lane_id).get("icon") or ""
            if re.match(r"^decade_\d{4}s$", lane_id):
                icon = icon or "📻"
            label = _lane_label(lane_id, active) if lane_id != "daily" else "Daily Modifier"
            icon_part = f"{icon} " if icon else ""
            print(f"    {icon_part}{label:<24}  {count:>3}x")
    if snapshot_path:
        snap = _build_snapshot(days, start, map_mode)
        Path(snapshot_path).write_text(json.dumps(snap, indent=2))
        print(f"\nSnapshot written to {snapshot_path}")
        return

    if fallback_days:
        print(f"\n  Fallback days ({len(fallback_days)}):")
        for fd in fallback_days:
            print(f"    {fd}")
    else:
        print("\n  No fallback days.")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Preview upcoming Daily setlists")
    p.add_argument("--days", type=int, default=90, metavar="N",
                   help="Number of days to preview (default: 90)")
    p.add_argument("--compact", action="store_true",
                   help="One line per day, no song details")
    p.add_argument("--start", metavar="YYYY-MM-DD",
                   help="Start date (default: today)")
    p.add_argument("--map", action="store_true",
                   help="Preview deterministic Map Mode generation as ASCII")
    p.add_argument("--snapshot", metavar="PATH",
                   help="Write deterministic snapshot to JSON file for comparison testing")
    args = p.parse_args()

    start = date.fromisoformat(args.start) if args.start else None
    run(days=args.days, compact=args.compact, start=start, map_mode=args.map, snapshot_path=args.snapshot)

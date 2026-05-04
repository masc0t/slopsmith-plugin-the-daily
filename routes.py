"""Daily Setlist plugin — seeded global setlist inspired by Slay the Spire."""

import hashlib
import logging
import sys
from fastapi import Request
import json
import requests
import random
import re
import secrets
import sqlite3
import threading
import urllib.request
import os
from datetime import date, datetime, timedelta
from pathlib import Path


def _date_seed(date_str):
    return hashlib.md5(date_str.encode()).hexdigest()[:6]

# ── Config ────────────────────────────────────────────────────────────────────
# Set these after creating your Supabase project (see README / plan).
SUPABASE_URL = "https://fzwjepglsewwvwfhghdh.supabase.co"
SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ6d2plcGdsc2V3d3Z3ZmhnaGRoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4OTUwODIsImV4cCI6MjA5MjQ3MTA4Mn0.mfXDg6LS8N6VrjXIyd8FJ0_QTjpJpUdyRmtgTV9FEOc"

# Raw GitHub URLs for pool versioning.
POOL_URL = "https://github.com/masc0t/slopsmith-plugin-the-daily/releases/download/pool-archive/pool-YYYY-MM-DD.json"
MANIFEST_URL = "https://github.com/masc0t/slopsmith-plugin-the-daily/releases/download/pool-archive/pool-manifest.json"
MODIFIERS_MANIFEST_URL = "https://github.com/masc0t/slopsmith-plugin-the-daily/releases/download/pool-archive/modifiers-manifest.json"

# Grace period for stale pool cache before hard-fail
POOL_STALE_GRACE_DAYS = 7

DEFAULT_SONG_COUNT = 3
MAP_MODE_START = date(2026, 4, 1)
BOSS_REROLL_ITEM = "boss_reroll"
LANE_REROLL_ITEM = "lane_reroll"

# Lightweight per-day leaderboard cache
import time as _time
_lb_cache = {}
LB_CACHE_TTL = 60  # seconds

# Leaderboard protection
NAME_MIN_LENGTH = 2
NAME_MAX_LENGTH = 20
IP_DAILY_LIMIT = 5
STREAK_LOOKBACK_DAYS = 30

# ── Day name ──────────────────────────────────────────────────────────────────
_EPOCH = date(2026, 4, 22)

def _get_today():
    # Allow tests to set a deterministic 'today' via env var
    t = os.environ.get("THE_DAILY_TEST_TODAY")
    if t:
        try:
            return date.fromisoformat(t)
        except Exception:
            pass
    return datetime.utcnow().date()


def _read_plugin_version():
    try:
        with open(Path(__file__).parent / "plugin.json") as f:
            return json.load(f).get("version", "0.0.0")
    except Exception:
        return "0.0.0"


def _is_debug_enabled() -> bool:
    try:
        with open(Path(__file__).parent / "plugin.json") as f:
            return json.load(f).get("debug", False) is True
    except Exception:
        return False


_PLUGIN_VERSION = _read_plugin_version()
_DEBUG_ENABLED = _is_debug_enabled()


def _day_name(date_str, mod, songs):
    if mod["type"] == "identity":
        key = mod.get("key")
        if key == "decade":
            years = [s["year"] for s in songs if s.get("year")]
            if years:
                return f"The {(int(years[0]) // 10) * 10}s"
        elif key == "artist":
            artists = [s["artist"] for s in songs if s.get("artist")]
            if artists:
                return artists[0]
        elif key == "album":
            albums = [s["album"] for s in songs if s.get("album")]
            if albums:
                return albums[0]
    n = (date.fromisoformat(date_str) - _EPOCH).days + 1
    return f"Daily #{n}"


# ── Modifier definitions ──────────────────────────────────────────────────────
def _is_new_blood(song):
    d = song.get("date_added_cf")
    if not d:
        return False
    try:
        return (datetime.utcnow().date() - date.fromisoformat(d)).days <= 60
    except (ValueError, TypeError):
        return False


def _is_fresh_week(song):
    d = song.get("date_added_cf")
    if not d:
        return False
    try:
        return (datetime.utcnow().date() - date.fromisoformat(d)).days <= 7
    except (ValueError, TypeError):
        return False


def _is_vintage_upload(song):
    d = song.get("date_added_cf")
    if not d:
        return False
    try:
        return (datetime.utcnow().date() - date.fromisoformat(d)).days >= 730
    except (ValueError, TypeError):
        return False


def _title_has_keywords(song, keywords):
    words = {w.strip(".,!?()\"'").lower() for w in song.get("title", "").split()}
    return bool(words & keywords)


def _title_chains(prev, curr):
    prev_words = prev.get("title", "").split()
    curr_words = curr.get("title", "").split()
    if not prev_words or not curr_words:
        return False
    return curr_words[0].strip(".,!?()\"'").lower() == prev_words[-1].strip(".,!?()\"'").lower()


def _tuning_family(song):
    t = (song.get("tuning") or "").lower()
    if t.startswith("drop"):
        return "drop"
    if t.startswith("e standard") or t in ("e std", "e"):
        return "standard"
    if t.startswith("eb") or t.startswith("e flat"):
        return "half_down"
    if t.startswith("d standard") or t.startswith("d std"):
        return "d_standard"
    if t.startswith("open"):
        return "open"
    return t.split()[0] if t else "unknown"


def _is_anniversary_year(song):
    y = song.get("year")
    if not y:
        return False
    try:
        return (datetime.utcnow().date().year - int(y)) in (10, 20, 30, 40)
    except (ValueError, TypeError):
        return False


def _is_prime(n):
    if n < 2:
        return False
    if n < 4:
        return True
    if n % 2 == 0 or n % 3 == 0:
        return False
    i = 5
    while i * i <= n:
        if n % i == 0 or n % (i + 2) == 0:
            return False
        i += 6
    return True


# ── Predicate DSL engine ──────────────────────────────────────────────────────
def _eval_predicate(song: dict, predicate: dict) -> bool:
    """Evaluate a predicate dict against a song. Returns False for unknown ops."""
    op = predicate.get("op")
    if op == "year_between":
        min_year = predicate.get("min", 0)
        max_year = predicate.get("max", 9999)
        year = song.get("year") or 0
        return min_year <= year <= max_year
    if op == "year_in":
        values = predicate.get("values", [])
        year = song.get("year")
        return year in values
    if op == "year_ends_with":
        digit = predicate.get("digit", "")
        year = song.get("year")
        if year is None:
            return False
        return str(year).endswith(digit)
    if op == "field_len_lte":
        field = predicate.get("field", "")
        n = predicate.get("n", 0)
        return len(song.get(field, "")) <= n
    if op == "field_len_gte":
        field = predicate.get("field", "")
        n = predicate.get("n", 0)
        return len(song.get(field, "")) >= n
    if op == "field_case":
        field = predicate.get("field", "")
        test = predicate.get("test", "")
        value = song.get(field, "")
        if test == "upper":
            return value.isupper()
        if test == "lower":
            return value.islower()
        return False
    if op == "field_contains_field":
        haystack = predicate.get("haystack", "")
        needle = predicate.get("needle", "")
        haystack_val = song.get(haystack, "").lower()
        needle_val = song.get(needle, "").lower()
        return needle_val in haystack_val
    if op == "field_keywords":
        field = predicate.get("field", "")
        words = predicate.get("words", [])
        value = song.get(field, "").lower()
        return any(w.lower() in value for w in words)
    if op == "same_first_letter":
        fields = predicate.get("fields", [])
        if len(fields) != 2:
            return False
        f1 = song.get(fields[0], "")
        f2 = song.get(fields[1], "")
        if not f1 or not f2:
            return False
        return f1[0].lower() == f2[0].lower()
    if op == "field_all_digits":
        field = predicate.get("field", "")
        value = song.get(field, "").replace(" ", "")
        return value.isdigit()
    if op == "field_has_nonalnum":
        field = predicate.get("field", "")
        value = song.get(field, "").replace(" ", "")
        return len(value) > 0 and not value.isalnum()
    return False


# ── Cosmetics catalog ───────────────────────────────────────────────────────
COSMETICS = {
    "flair_glow":       {"type": "flair",         "cost": 15, "name": "Glow Flair"},
    "theme_papercraft": {"type": "map_theme",     "cost": 25, "name": "Papercraft"},
    "skin_neonsprint":  {"type": "lane_skin",     "cost": 20, "name": "Neon Sprint", "lane": "sprint"},
    "calendar_pastel":  {"type": "calendar_art",  "cost": 10, "name": "Pastel Calendar"},
}

CONSUMABLES = {
    "boss_reroll":  {"cost": 8,  "name": "Boss Re-roll",  "description": "Re-roll today's boss song.",                  "fn": "_consume_boss_reroll"},
    "lane_reroll":  {"cost": 12, "name": "Lane Re-roll",  "description": "Re-roll non-boss songs on a single lane.",     "fn": "_consume_lane_reroll"},
}
# NB: per ADR-0002 amendment, NO peek consumables here. Peeks live at treasure nodes.

# ── Shop helper functions ──────────────────────────────────────────────
def _shop_offer_for_node(date_str: str, node_id: str) -> set[str]:
    rng = random.Random(f"shop:{date_str}:{node_id}")
    catalog_ids = list(COSMETICS.keys()) + list(CONSUMABLES.keys())
    return set(rng.sample(catalog_ids, min(3, len(catalog_ids))))


def _record_purchase_time(install_id: str, item_id: str):
    conn = _get_conn()
    with _lock:
        conn.execute(
            "INSERT OR REPLACE INTO daily_purchases (install_id, item_id, purchased_at) VALUES (?, ?, ?)",
            (install_id, item_id, datetime.utcnow().isoformat()),
        )
        conn.commit()


def _get_purchase_time(install_id: str, item_id: str):
    conn = _get_conn()
    row = conn.execute(
        "SELECT purchased_at FROM daily_purchases WHERE install_id = ? AND item_id = ?",
        (install_id, item_id),
    ).fetchone()
    if not row:
        return None
    try:
        return datetime.fromisoformat(row[0])
    except Exception:
        return None


def _execute_consumable(item_id: str, install_id: str) -> dict:
    fn_name = CONSUMABLES.get(item_id, {}).get("fn")
    if fn_name and fn_name in globals():
        return globals()[fn_name](install_id)
    return {}


def _consume_boss_reroll(install_id: str) -> dict:
    """Re-roll today's boss song. Stub — flesh out by reusing existing setlist generation logic."""
    return {"rerolled": True}


def _consume_lane_reroll(install_id: str, node_id: str) -> dict:
    """Re-roll non-boss songs on a single lane."""
    # Logic to process the re-roll
    # In a real impl, this would regenerate the lane paths/songs and update the DB
    today = _get_today().isoformat()
    # Mocking reroll for lane validation in debug mode
    return {"rerolled": True, "node_id": node_id}

# ── Stamp definitions ────────────────────────────────────────────────────────
def _compute_stamp_aggregates(conn, install_id):
    """Compute aggregates needed for stamp eligibility checks."""
    # Lane clears: count cleared nodes per lane for this install
    lane_clears = {}
    rows = conn.execute(
        "SELECT dc.date, dc.node_id FROM daily_completions dc "
        "JOIN daily_setlists ds ON ds.date = dc.date "
        "WHERE dc.install_id = ? AND ds.map IS NOT NULL",
        (install_id,)
    ).fetchall()
    # We need to parse map JSON to get lane per node
    for row in conn.execute("SELECT date, map FROM daily_setlists WHERE map IS NOT NULL").fetchall():
        map_data = json.loads(row[1]) if row[1] else None
        if not map_data:
            continue
        nodes_by_id = _node_by_id(map_data)
        for r in rows:
            if r[0] and r[1]:
                node = nodes_by_id.get(r[1])
                if node and node.get("lane"):
                    lane_clears[node["lane"]] = lane_clears.get(node["lane"], 0) + 1

    # Unique modifiers seen
    mod_rows = conn.execute(
        "SELECT DISTINCT modifier FROM daily_setlists s "
        "JOIN daily_completions c ON c.date = s.date "
        "WHERE c.install_id = ?",
        (install_id,)
    ).fetchall()
    modifiers_seen = [r[0] for r in mod_rows if r[0]]

    # Decades seen
    decades_seen = set()
    for r in conn.execute(
        "SELECT songs FROM daily_setlists s "
        "JOIN daily_completions c ON c.date = s.date "
        "WHERE c.install_id = ?",
        (install_id,)
    ).fetchall():
        if r[0]:
            for s in json.loads(r[0]):
                y = s.get("year")
                if y:
                    decades_seen.add((int(y) // 10) * 10)

    # Streak
    streak = _compute_streak(conn, _get_today().isoformat())

    # Total completions
    total_completions = conn.execute(
        "SELECT COUNT(*) FROM daily_completions WHERE install_id = ?",
        (install_id,)
    ).fetchone()[0]

    return {
        "lane_clears": lane_clears,
        "modifiers_seen": modifiers_seen,
        "decades_seen": list(decades_seen),
        "streak": streak,
        "total_completions": total_completions,
    }


def _check_stamps(conn, install_id):
    """Check and award any newly eligible stamps. Returns list of new stamp_ids."""
    if not install_id:
        return []
    existing = {r[0] for r in conn.execute(
        "SELECT stamp_id FROM daily_stamps WHERE install_id = ?",
        (install_id,)
    ).fetchall()}

    agg = _compute_stamp_aggregates(conn, install_id)
    new_stamps = []

    # Lane mastery stamps
    for lane, count in agg["lane_clears"].items():
        for milestone in [10, 25, 50]:
            stamp_id = f"lane_{lane}_{milestone}"
            if milestone <= count and stamp_id not in existing:
                new_stamps.append(stamp_id)

    # Modifier stamps (one per unique modifier seen)
    for mod_id in agg["modifiers_seen"]:
        stamp_id = f"modifier_{mod_id}"
        if stamp_id not in existing:
            new_stamps.append(stamp_id)

    # Decade stamps
    for decade in agg["decades_seen"]:
        stamp_id = f"decade_{decade}s"
        if stamp_id not in existing:
            new_stamps.append(stamp_id)

    # Streak milestones (every 7)
    for milestone in range(7, max(agg["streak"] + 1, 8), 7):
        stamp_id = f"streak_{milestone}"
        if stamp_id not in existing:
            new_stamps.append(stamp_id)

    # Total completions milestones
    for milestone in [50, 100, 200, 500]:
        if agg["total_completions"] >= milestone:
            stamp_id = f"completions_{milestone}"
            if stamp_id not in existing:
                new_stamps.append(stamp_id)

    if new_stamps:
        today_str = _get_today().isoformat()
        with _lock:
            for stamp_id in new_stamps:
                conn.execute(
                    "INSERT OR IGNORE INTO daily_stamps (install_id, stamp_id, earned_date) VALUES (?, ?, ?)",
                    (install_id, stamp_id, today_str),
                )
            conn.commit()
        _mirror_push_debounced(install_id)

    return new_stamps


# ── Token award helpers ──────────────────────────────────────────────────────
def _award_tokens(conn, install_id, date_str, delta, reason):
    """Award tokens and write ledger entry."""
    if not install_id or delta <= 0:
        return 0
    with _lock:
        conn.execute(
            "UPDATE daily_inventory SET tokens = tokens + ? WHERE install_id = ?",
            (delta, install_id),
        )
        conn.execute(
            "INSERT INTO daily_token_ledger (install_id, date, delta, reason) VALUES (?, ?, ?, ?)",
            (install_id, date_str, delta, reason),
        )
        conn.commit()
    return delta


def _get_token_balance(conn, install_id):
    row = conn.execute(
        "SELECT tokens FROM daily_inventory WHERE install_id = ?",
        (install_id,)
    ).fetchone()
    return row[0] if row else 0


# ── Database ──────────────────────────────────────────────────────────────────
_db_path = None
_conn = None
_lock = threading.Lock()


def _get_conn():
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(_db_path, check_same_thread=False)
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.executescript("""
            CREATE TABLE IF NOT EXISTS daily_setlists (
                date       TEXT PRIMARY KEY,
                day_name   TEXT NOT NULL,
                modifier   TEXT NOT NULL,
                songs      TEXT NOT NULL,
                song_count INTEGER NOT NULL,
                pool_stamp TEXT
            );
            CREATE TABLE IF NOT EXISTS daily_completions (
                date         TEXT NOT NULL,
                cf_id        INTEGER NOT NULL,
                completed_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (date, cf_id)
            );
            CREATE TABLE IF NOT EXISTS pool_cache (
                pool_stamp TEXT PRIMARY KEY,
                pool       TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS modifier_manifest_cache (
                date      TEXT PRIMARY KEY,
                manifest  TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS daily_inventory (
                install_id TEXT PRIMARY KEY,
                items TEXT NOT NULL DEFAULT '[]',
                last_streak_milestone INTEGER NOT NULL DEFAULT 0,
                starter_awarded INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT,
                tokens INTEGER NOT NULL DEFAULT 0,
                cosmetics TEXT NOT NULL DEFAULT '[]',
                equipped TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE IF NOT EXISTS daily_boss_rerolls (
                install_id TEXT NOT NULL,
                date TEXT NOT NULL,
                rerolled_cf_id INTEGER NOT NULL,
                PRIMARY KEY (install_id, date)
            );
        CREATE TABLE IF NOT EXISTS daily_node_commits (
                install_id TEXT NOT NULL,
                date TEXT NOT NULL,
                node_id TEXT NOT NULL,
                cf_id INTEGER,
                committed_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (install_id, date, node_id)
            );
            CREATE TABLE IF NOT EXISTS daily_node_actions (
                install_id TEXT NOT NULL,
                date TEXT NOT NULL,
                node_id TEXT NOT NULL,
                action TEXT NOT NULL,
                payload TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (install_id, date, node_id, action)
            );
            CREATE TABLE IF NOT EXISTS daily_stamps (
                install_id TEXT NOT NULL,
                stamp_id TEXT NOT NULL,
                earned_date TEXT NOT NULL,
                PRIMARY KEY (install_id, stamp_id)
            );
            CREATE TABLE IF NOT EXISTS daily_token_ledger (
                install_id TEXT NOT NULL,
                date TEXT NOT NULL,
                delta INTEGER NOT NULL,
                reason TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        """)
        _ensure_column(_conn, "daily_setlists", "map", "TEXT")
        _ensure_column(_conn, "daily_setlists", "fallback", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(_conn, "daily_completions", "node_id", "TEXT")
        _ensure_column(_conn, "daily_completions", "install_id", "TEXT")
        _ensure_column(_conn, "daily_completions", "committed_lane", "TEXT")
        _ensure_column(_conn, "daily_inventory", "starter_awarded", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(_conn, "daily_inventory", "tokens", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(_conn, "daily_inventory", "cosmetics", "TEXT NOT NULL DEFAULT '[]'")
        _ensure_column(_conn, "daily_inventory", "equipped", "TEXT NOT NULL DEFAULT '{}'")
        _ensure_column(_conn, "daily_inventory", "recovery_code", "TEXT")
        _ensure_column(_conn, "daily_setlists", "lane_paths", "TEXT")
        _ensure_column(_conn, "daily_node_actions", "payload", "TEXT")
        _conn.execute("CREATE TABLE IF NOT EXISTS daily_purchases (install_id TEXT NOT NULL, item_id TEXT NOT NULL, purchased_at TEXT NOT NULL, PRIMARY KEY (install_id, item_id))")
        _conn.commit()
    return _conn


def _ensure_column(conn, table, column, ddl):
    cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


# ── Recovery code (BIP39-4word) ────────────────────────────────────────────
_BIP39_WORDS = None


def _load_word_list():
    global _BIP39_WORDS
    if _BIP39_WORDS is not None:
        return _BIP39_WORDS
    try:
        path = Path(__file__).parent / "static" / "bip39-4word.json"
        _BIP39_WORDS = json.loads(path.read_text())
    except Exception:
        _BIP39_WORDS = ["forest", "anchor", "rapid", "mint", "spark",
                        "river", "stone", "amber", "cloud", "metal"]
    return _BIP39_WORDS


def _generate_recovery_code() -> str:
    words = _load_word_list()
    return "-".join(secrets.choice(words) for _ in range(4))


def _get_or_create_recovery_code(conn, install_id: str) -> str:
    row = conn.execute(
        "SELECT recovery_code FROM daily_inventory WHERE install_id = ?",
        (install_id,)
    ).fetchone()
    if row and row[0]:
        return row[0]
    code = _generate_recovery_code()
    with _lock:
        conn.execute("""
            INSERT INTO daily_inventory (install_id, recovery_code)
            VALUES (?, ?)
            ON CONFLICT(install_id) DO UPDATE SET recovery_code = excluded.recovery_code
            WHERE daily_inventory.recovery_code IS NULL
        """, (install_id, code))
        conn.commit()
    return code


def _is_valid_code_shape(code: str) -> bool:
    parts = code.split("-")
    if len(parts) != 4:
        return False
    return all(p.isalpha() and 3 <= len(p) <= 8 for p in parts)


# ── Pool loading ──────────────────────────────────────────────────────────────
def _fetch_manifest():
    """Fetch the pool manifest (list of stamps). Returns list of stamps or None on failure."""
    if not MANIFEST_URL:
        return None
    try:
        req = urllib.request.Request(MANIFEST_URL)
        req.add_header("User-Agent", "slopsmith-daily/1.0")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            return data.get("stamps", [])
    except Exception:
        return None


def _fetch_pool_by_stamp(stamp: str) -> list | None:
    """Fetch a specific pool by its stamp. Returns pool list or None on failure."""
    url = POOL_URL.replace("YYYY-MM-DD", stamp)
    try:
        req = urllib.request.Request(url)
        req.add_header("User-Agent", "slopsmith-daily/1.0")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def _latest_leq_stamp(stamps: list, target_date: date) -> str | None:
    """Find the largest stamp <= target_date."""
    valid = [s for s in stamps if s <= target_date.isoformat()]
    if not valid:
        return None
    return max(valid)


def _load_pool(date_str, plugin_dir):
    """Load pool for a specific date using manifest+stamp versioning."""
    target_date = date.fromisoformat(date_str)
    conn = _get_conn()

    stamps = _fetch_manifest()

    if stamps:
        stamp = _latest_leq_stamp(stamps, target_date)
        if stamp:
            row = conn.execute(
                "SELECT pool FROM pool_cache WHERE pool_stamp = ?", (stamp,)
            ).fetchone()
            if row:
                return json.loads(row[0])

            pool = _fetch_pool_by_stamp(stamp)
            if pool:
                pool = [s for s in pool
                        if len((s.get("artist") or "").strip()) >= 2
                        and len((s.get("title") or "").strip()) >= 2
                        and "full album" not in (s.get("title") or "").lower()]
                with _lock:
                    conn.execute(
                        "INSERT OR REPLACE INTO pool_cache (pool_stamp, pool, fetched_at) VALUES (?, ?, ?)",
                        (stamp, json.dumps(pool), datetime.utcnow().isoformat())
                    )
                    conn.commit()
                return pool

    raise RuntimeError(f"Failed to fetch pool from releases for {date_str}")


def _get_pool_stamp(date_str: str) -> str | None:
    """Get the pool stamp that would be used for a given date."""
    target_date = date.fromisoformat(date_str)

    stamps = _fetch_manifest()
    if stamps:
        stamp = _latest_leq_stamp(stamps, target_date)
        if stamp:
            return stamp

    stamps_from_db = [r[0] for r in _get_conn().execute(
        "SELECT pool_stamp FROM pool_cache ORDER BY pool_stamp DESC"
    ).fetchall()]
    return _latest_leq_stamp(stamps_from_db, target_date)


# ── Modifier manifest loading ────────────────────────────────────────────────
def _fetch_modifier_manifest() -> dict | None:
    """Fetch the modifiers manifest. Returns parsed JSON or None on failure."""
    if not MODIFIERS_MANIFEST_URL:
        return None
    try:
        req = urllib.request.Request(MODIFIERS_MANIFEST_URL)
        req.add_header("User-Agent", "slopsmith-daily/1.0")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def _load_modifier_manifest(date_str: str) -> dict:
    """Load modifier manifest for a date, using cache or fetching."""
    conn = _get_conn()

    row = conn.execute(
        "SELECT manifest FROM modifier_manifest_cache WHERE date = ?", (date_str,)
    ).fetchone()
    if row:
        return json.loads(row[0])

    manifest = _fetch_modifier_manifest()
    if manifest is None:
        raise RuntimeError("offline")

    with _lock:
        conn.execute(
            "INSERT OR REPLACE INTO modifier_manifest_cache (date, manifest, fetched_at) VALUES (?, ?, ?)",
            (date_str, json.dumps(manifest), datetime.utcnow().isoformat())
        )
        conn.commit()
    return manifest


def _resolve_modifier_stamp(manifest: dict, date_str: str) -> dict:
    """Find the latest stamp <= date_str in the manifest. Returns the stamp dict."""
    target_date = date.fromisoformat(date_str)
    stamps = manifest.get("stamps", [])

    valid = [s for s in stamps if date.fromisoformat(s["date"]) <= target_date]
    if not valid:
        raise RuntimeError(f"No modifier stamp applicable for {date_str}")

    return max(valid, key=lambda s: date.fromisoformat(s["date"]))


def _check_version_gate(stamp: dict):
    """Check if plugin version meets min_plugin_version. Raises on failure."""
    min_version = stamp.get("min_plugin_version")
    if min_version is None:
        return

    try:
        from packaging.version import Version
        if Version(_PLUGIN_VERSION) < Version(min_version):
            raise RuntimeError(f"update_required:{min_version}")
    except ImportError:
        def parse_semver(v):
            parts = v.split(".")
            return tuple(int(p) for p in parts[:3]) + (0,) * (3 - len(parts))
        if parse_semver(_PLUGIN_VERSION) < parse_semver(min_version):
            raise RuntimeError(f"update_required:{min_version}")


# ── Algorithm registry ───────────────────────────────────────────────────────────
# Wrapper functions for algorithm-parameterized modifiers

def _key_year_desc(s):
    return -int(s.get("year") or 0)

def _key_title_lower(s):
    return s.get("title", "").lower()

def _key_artist_first_letter(s):
    return s.get("artist", "")[:1].upper()

def _key_title_first_letter(s):
    return s.get("title", "")[:1].upper()

def _filter_one_word(s):
    return len(s.get("title", "").split()) == 1

def _filter_five_words(s):
    return len(s.get("title", "").split()) >= 5

def _filter_two_words(s):
    return len(s.get("title", "").split()) == 2

def _filter_has_digit(s):
    return any(c.isdigit() for c in s.get("title", ""))

def _filter_has_punct(s):
    return any(c in s.get("title", "") for c in "?!()")

def _filter_title_equals_album(s):
    return s.get("title", "").strip().lower() == s.get("album", "").strip().lower()

def _seq_tuning_family_diff(prev, curr):
    return _tuning_family(prev) != _tuning_family(curr)

def _filter_prime_time(s):
    return _is_prime(int(s.get("year") or 0))

def _filter_witching_hour(s):
    return _title_has_keywords(s, {"death", "dead", "ghost", "fire", "blood", "devil", "grave", "hell", "kill", "pain", "dark"})

def _filter_love_letter(s):
    return _title_has_keywords(s, {"love", "heart", "kiss", "baby", "goodbye", "missing", "lonely"})

def _filter_rorschach(s):
    return _title_has_keywords(s, {"heart", "eye", "eyes", "hand", "hands", "blood", "bone", "bones", "skin", "face", "soul", "mind", "head"})

def _filter_weather_report(s):
    return _title_has_keywords(s, {"rain", "storm", "sun", "moon", "cloud", "wind", "thunder", "lightning", "snow", "sky", "star", "stars"})

def _filter_color_wheel(s):
    return _title_has_keywords(s, {"red", "blue", "green", "black", "white", "gold", "silver", "yellow", "purple", "orange", "gray", "grey", "crimson"})

def _filter_motion_picture(s):
    return _title_has_keywords(s, {"run", "running", "fly", "flying", "fall", "falling", "dance", "dancing", "walk", "walking", "jump", "drive"})

def _filter_sundown(s):
    return _title_has_keywords(s, {"last", "final", "end", "ending", "goodbye", "over", "gone", "forever", "never"})

_ALGORITHM_REGISTRY = {
    "_is_new_blood": _is_new_blood,
    "_is_fresh_week": _is_fresh_week,
    "_is_vintage_upload": _is_vintage_upload,
    "_is_anniversary_year": _is_anniversary_year,
    "_title_chains": _title_chains,
    "_title_track": _filter_title_equals_album,
    "_key_year_desc": _key_year_desc,
    "_key_title_lower": _key_title_lower,
    "_key_artist_first_letter": _key_artist_first_letter,
    "_key_title_first_letter": _key_title_first_letter,
    "_filter_one_word": _filter_one_word,
    "_filter_five_words": _filter_five_words,
    "_filter_two_words": _filter_two_words,
    "_filter_has_digit": _filter_has_digit,
    "_filter_has_punct": _filter_has_punct,
    "_tuning_family_diff": _seq_tuning_family_diff,
    "_prime_time": _filter_prime_time,
    "_witching_hour": _filter_witching_hour,
    "_love_letter": _filter_love_letter,
    "_rorschach": _filter_rorschach,
    "_weather_report": _filter_weather_report,
    "_color_wheel": _filter_color_wheel,
    "_motion_picture": _filter_motion_picture,
    "_sundown": _filter_sundown,
}


def _get_active_modifier(date_str: str) -> list:
    """Get the active modifier list for a date, raising on offline or version gate."""
    manifest = _load_modifier_manifest(date_str)
    stamp = _resolve_modifier_stamp(manifest, date_str)
    _check_version_gate(stamp)
    return stamp.get("active", [])


# ── Modifier selection ────────────────────────────────────────────────────────
def _pick_modifier(date_str, active):
    rng = random.Random(_date_seed(date_str))
    ids = [m["id"] for m in active]
    rng.shuffle(ids)
    return ids[0]


def _identity_candidates(date_str, pool, key, count, min_pool=None, exclude=None, seed_suffix=None):
    seed_key = seed_suffix or (key if isinstance(key, str) else "callable")
    rng = random.Random(_date_seed(date_str) + seed_key)

    groups = {}
    if callable(key):
        for s in pool:
            try:
                v = key(s)
            except Exception:
                continue
            if v is not None and v != "":
                groups.setdefault(v, []).append(s)
    elif key == "decade":
        for s in pool:
            y = s.get("year")
            if y:
                decade = (int(y) // 10) * 10
                groups.setdefault(decade, []).append(s)
    else:
        for s in pool:
            v = s.get(key)
            if v is not None:
                if isinstance(v, str):
                    v = v.strip()
                if v:
                    groups.setdefault(v, []).append(s)

    threshold = max(min_pool or 0, count)
    eligible = {k: v for k, v in groups.items() if len(v) >= threshold}
    if exclude:
        eligible = {k: v for k, v in eligible.items() if str(k).lower() not in exclude}
    while not eligible and threshold > 1:
        threshold -= 1
        eligible = {k: v for k, v in groups.items() if len(v) >= threshold}
    if not eligible:
        return pool, True

    chosen = rng.choice(sorted(eligible.keys(), key=str))
    return eligible[chosen], False


def _field_value(song, field):
    """Resolve a field name, including computed fields like 'decade'."""
    if field == "decade":
        y = song.get("year")
        try:
            return (int(y) // 10) * 10 if y else None
        except (ValueError, TypeError):
            return None
    v = song.get(field)
    if isinstance(v, str):
        v = v.strip() or None
    return v


def _fallback_sample(pool, count, date_str, seed_suffix):
    """Return count random songs from pool, used when a modifier cannot be satisfied."""
    rng = random.Random(_date_seed(date_str) + seed_suffix + "fallback")
    return rng.sample(pool, min(count, len(pool))), count, True


def _select_composite(date_str, modifier_id, pool, count, active):
    """composite: chain of rules like identity:field, unique:field, order:field."""
    mod = next(m for m in active if m["id"] == modifier_id)
    rng = random.Random(_date_seed(date_str) + modifier_id + "composite")

    identity_field = None
    unique_fields = []
    order_field = None
    for rule in mod.get("rules", []):
        kind, _, field = rule.partition(":")
        if kind == "identity":
            identity_field = field
        elif kind == "unique":
            unique_fields.append(field)
        elif kind == "order":
            order_field = field

    candidates = list(pool)

    if identity_field:
        if unique_fields:
            # Pre-validate: pick an identity group that can satisfy all unique constraints
            id_groups: dict = {}
            for s in candidates:
                v = _field_value(s, identity_field)
                if v is not None:
                    id_groups.setdefault(v, []).append(s)

            def _group_ok(songs):
                for uf in unique_fields:
                    n = len({_field_value(s, uf) for s in songs
                             if _field_value(s, uf) is not None})
                    if n < count:
                        return False
                return True

            eligible = {k: v for k, v in id_groups.items() if _group_ok(v)}
            if not eligible:
                return _fallback_sample(pool, count, date_str, modifier_id)
            chosen_key = rng.choice(sorted(eligible.keys(), key=str))
            candidates = eligible[chosen_key]
        else:
            candidates, fallback = _identity_candidates(
                date_str, candidates, identity_field, count,
                seed_suffix=modifier_id,
            )
            if fallback:
                return _fallback_sample(pool, count, date_str, modifier_id)

    if unique_fields:
        for ufield in unique_fields:
            groups: dict = {}
            for s in candidates:
                v = _field_value(s, ufield)
                if v is not None:
                    groups.setdefault(v, []).append(s)
            keys = sorted(groups.keys(), key=str)
            rng.shuffle(keys)
            picked = [rng.choice(groups[k]) for k in keys[:count * 4]]
            candidates = picked if picked else candidates

    if len(candidates) < count:
        return _fallback_sample(pool, count, date_str, modifier_id)

    selected = rng.sample(candidates, min(count, len(candidates)))

    if order_field:
        try:
            selected.sort(key=lambda s: int(_field_value(s, order_field) or 0))
        except Exception:
            pass

    return selected, len(selected), False


def _select_sequence(date_str, modifier_id, pool, count, active):
    """sequence: each adjacent pair must satisfy fn(prev, curr)."""
    mod = next(m for m in active if m["id"] == modifier_id)
    fn_name = mod.get("fn")
    fn = _ALGORITHM_REGISTRY.get(fn_name) if fn_name else None
    rng = random.Random(_date_seed(date_str) + modifier_id + "seq")

    shuffled = list(pool)
    rng.shuffle(shuffled)

    # Try up to 200 random starting positions
    for start in range(min(200, len(shuffled))):
        chain = [shuffled[start]]
        remaining = shuffled[:start] + shuffled[start + 1:]
        for _ in range(count - 1):
            for i, s in enumerate(remaining):
                if fn and fn(chain[-1], s):
                    chain.append(s)
                    remaining.pop(i)
                    break
            else:
                break
        if len(chain) >= count:
            return chain[:count], count, False

    return _fallback_sample(pool, count, date_str, modifier_id)


def _select_structural(date_str, modifier_id, pool, count, active):
    """structural: enforces positional shapes (bookend, alternating)."""
    mod = next(m for m in active if m["id"] == modifier_id)
    shape = mod.get("shape")
    key = mod.get("key")
    rng = random.Random(_date_seed(date_str) + modifier_id + "struct")

    if shape == "bookend":
        groups: dict = {}
        for s in pool:
            v = (s.get(key) or "").strip()
            if v:
                groups.setdefault(v, []).append(s)
        eligible = {k: v for k, v in groups.items() if len(v) >= 2}
        if not eligible:
            return _fallback_sample(pool, count, date_str, modifier_id)
        artist = rng.choice(sorted(eligible.keys()))
        b1, b2 = rng.sample(eligible[artist], 2)
        used = {b1["cf_id"], b2["cf_id"]}
        others = [s for s in pool if s["cf_id"] not in used]
        rng.shuffle(others)
        middle = others[:count - 2]
        if len(middle) < count - 2:
            return _fallback_sample(pool, count, date_str, modifier_id)
        return [b1] + middle + [b2], count, False

    elif shape == "alternating":
        groups: dict = {}
        for s in pool:
            v = (s.get(key) or "").strip()
            if v:
                groups.setdefault(v, []).append(s)
        half = (count + 1) // 2
        eligible = {k: v for k, v in groups.items() if len(v) >= half}
        if len(eligible) < 2:
            return _fallback_sample(pool, count, date_str, modifier_id)
        artists = sorted(eligible.keys())
        rng.shuffle(artists)
        a1, a2 = artists[0], artists[1]
        pool_a1 = rng.sample(eligible[a1], min(half, len(eligible[a1])))
        pool_a2 = rng.sample(eligible[a2], min(half, len(eligible[a2])))
        result = []
        for i in range(count):
            src = pool_a1 if i % 2 == 0 else pool_a2
            if src:
                result.append(src.pop(0))
        if len(result) < count:
            return _fallback_sample(pool, count, date_str, modifier_id)
        return result, count, False

    return _fallback_sample(pool, count, date_str, modifier_id)


def _select_meta(date_str, modifier_id, pool, count, active, exclude=None):
    """meta: delegates or wraps other modifiers."""
    non_meta = [m["id"] for m in active if m.get("type") != "meta"]
    rng = random.Random(_date_seed(date_str) + modifier_id + "meta")

    if modifier_id == "dealers_choice":
        chosen = rng.choice(non_meta)
        return _select_songs(date_str, chosen, pool, active, exclude=exclude)

    if modifier_id == "double_trouble":
        chosen = rng.sample(non_meta, 2)
        candidates = list(pool)
        for mid in chosen:
            m = next((mod for mod in active if mod["id"] == mid), None)
            if m and m.get("type") == "filter":
                if "predicate" in m:
                    filtered = [s for s in candidates if _eval_predicate(s, m["predicate"])]
                elif "fn" in m:
                    fn = _ALGORITHM_REGISTRY.get(m["fn"])
                    filtered = [s for s in candidates if fn and fn(s)] if fn else candidates
                else:
                    filtered = candidates
                if len(filtered) >= count:
                    candidates = filtered
        rng2 = random.Random(_date_seed(date_str) + "songs")
        selected = rng2.sample(candidates, min(count, len(candidates)))
        return selected, len(selected), False

    # reanimated, secret_handshake — random selection
    rng2 = random.Random(_date_seed(date_str) + "songs")
    selected = rng2.sample(pool, min(count, len(pool)))
    return selected, len(selected), False


def _select_songs(date_str, modifier_id, pool, active, exclude=None):
    mod = next(m for m in active if m["id"] == modifier_id)
    mod_type = mod["type"]
    count = mod.get("count", DEFAULT_SONG_COUNT)
    fallback = False

    if mod_type in ("filter", "filter+count"):
        if "predicate" in mod:
            candidates = [s for s in pool if _eval_predicate(s, mod["predicate"])]
        elif "fn" in mod:
            fn_name = mod["fn"]
            fn = _ALGORITHM_REGISTRY.get(fn_name)
            if fn is None:
                candidates = pool
            else:
                candidates = [s for s in pool if fn(s)]
        else:
            candidates = pool
        if len(candidates) < count:
            candidates = pool
            fallback = True
    elif mod_type == "identity":
        key = mod.get("key")
        if key in _ALGORITHM_REGISTRY:
            key = _ALGORITHM_REGISTRY[key]
        candidates, fallback = _identity_candidates(
            date_str, pool, key, count, mod.get("min_pool"),
            exclude=exclude, seed_suffix=modifier_id,
        )
        count = DEFAULT_SONG_COUNT
    elif mod_type == "composite":
        return _select_composite(date_str, modifier_id, pool, count, active)
    elif mod_type == "ordering":
        candidates = list(pool)
    elif mod_type == "sequence":
        return _select_sequence(date_str, modifier_id, pool, count, active)
    elif mod_type == "structural":
        return _select_structural(date_str, modifier_id, pool, count, active)
    elif mod_type == "meta":
        return _select_meta(date_str, modifier_id, pool, count, active, exclude=exclude)
    else:
        candidates = pool

    rng = random.Random(_date_seed(date_str) + "songs")
    selected = rng.sample(candidates, min(count, len(candidates)))

    if mod_type == "ordering":
        key = mod.get("key")
        if key and key in _ALGORITHM_REGISTRY:
            key = _ALGORITHM_REGISTRY[key]
        if callable(key):
            try:
                selected = sorted(selected, key=key)
            except Exception:
                pass

    return selected, len(selected), fallback


# ── Map Mode generation ───────────────────────────────────────────────────────
MAP_LANES = {
    "standard": {
        "label": "Standard",
        "icon": "🎸",
        "fn": lambda s: _tuning_family(s) == "standard",
    },
    "drop": {
        "label": "Drop",
        "icon": "⬇️",
        "fn": lambda s: _tuning_family(s) == "drop",
    },
    "flat": {
        "label": "Flat",
        "icon": "🌍",
        "fn": lambda s: _tuning_family(s) == "half_down",
    },
    "sprint": {
        "label": "Sprint",
        "icon": "⚡",
        "fn": lambda s: _song_duration_seconds(s) is not None and _song_duration_seconds(s) < 180,
    },
    "marathon": {
        "label": "Marathon",
        "icon": "🌙",
        "fn": lambda s: _song_duration_seconds(s) is not None and _song_duration_seconds(s) > 300,
    },
    "decade": {
        "label": "Decade",
        "icon": "📻",
        "dynamic": "decade",
    },
}

MAP_SHAPE_WEIGHTS = [
    ("fork", 30),
    ("diamond", 30),
    ("crossroads", 20),
    ("bramble", 12),
    ("spiral", 8),
]


def _song_duration_seconds(song):
    raw = song.get("duration")
    if raw is None or raw == "":
        return None
    if isinstance(raw, (int, float)):
        return int(raw)
    text = str(raw).strip()
    if not text:
        return None
    try:
        return int(float(text))
    except ValueError:
        pass
    parts = text.split(":")
    if len(parts) in (2, 3):
        try:
            nums = [int(p) for p in parts]
        except ValueError:
            return None
        seconds = 0
        for n in nums:
            seconds = seconds * 60 + n
        return seconds
    return None


def _weighted_choice(rng, weighted_items):
    total = sum(weight for _, weight in weighted_items)
    pick = rng.uniform(0, total)
    upto = 0
    for item, weight in weighted_items:
        upto += weight
        if pick <= upto:
            return item
    return weighted_items[-1][0]


def _map_shape_template(shape, act=None, row_offset=0):
    def _row(r):
        return r + row_offset
    if shape == "fork":
        return [
            {"id": f"n0_{act}" if act else "n0", "row": _row(0), "col": 1, "lane_slot": None, "edges": ["n1", "n2"], "act": act},
            {"id": f"n1_{act}" if act else "n1", "row": _row(1), "col": 0, "lane_slot": 0, "edges": ["n3"], "act": act},
            {"id": f"n2_{act}" if act else "n2", "row": _row(1), "col": 2, "lane_slot": 1, "edges": ["n4"], "act": act},
            {"id": f"n3_{act}" if act else "n3", "row": _row(2), "col": 0, "lane_slot": 0, "edges": ["nb"], "act": act},
            {"id": f"n4_{act}" if act else "n4", "row": _row(2), "col": 2, "lane_slot": 1, "edges": ["nb"], "act": act},
            {"id": f"nb_{act}" if act else "nb", "row": _row(3), "col": 1, "lane_slot": None, "edges": [], "act": act},
        ]
    if shape == "diamond":
        return [
            {"id": f"n0_{act}" if act else "n0", "row": _row(0), "col": 1, "lane_slot": None, "edges": ["n1", "n2"], "act": act},
            {"id": f"n1_{act}" if act else "n1", "row": _row(1), "col": 0, "lane_slot": 0, "edges": ["n3"], "act": act},
            {"id": f"n2_{act}" if act else "n2", "row": _row(1), "col": 2, "lane_slot": 1, "edges": ["n3"], "act": act},
            {"id": f"n3_{act}" if act else "n3", "row": _row(2), "col": 1, "lane_slot": None, "edges": ["n4", "n5"], "act": act},
            {"id": f"n4_{act}" if act else "n4", "row": _row(3), "col": 0, "lane_slot": 0, "edges": ["nb"], "act": act},
            {"id": f"n5_{act}" if act else "n5", "row": _row(3), "col": 2, "lane_slot": 1, "edges": ["nb"], "act": act},
            {"id": f"nb_{act}" if act else "nb", "row": _row(4), "col": 1, "lane_slot": None, "edges": [], "act": act},
        ]
    if shape == "crossroads":
        return [
            {"id": f"n0_{act}" if act else "n0", "row": _row(0), "col": 1, "lane_slot": None, "edges": ["n1", "n2", "n3"], "act": act},
            {"id": f"n1_{act}" if act else "n1", "row": _row(1), "col": 0, "lane_slot": 0, "edges": ["n4", "n5"], "act": act},
            {"id": f"n2_{act}" if act else "n2", "row": _row(1), "col": 1, "lane_slot": 1, "edges": ["n5"], "act": act},
            {"id": f"n3_{act}" if act else "n3", "row": _row(1), "col": 2, "lane_slot": 2, "edges": ["n5", "n6"], "act": act},
            {"id": f"n4_{act}" if act else "n4", "row": _row(2), "col": 0, "lane_slot": 0, "edges": ["n7"], "act": act},
            {"id": f"n5_{act}" if act else "n5", "row": _row(2), "col": 1, "lane_slot": 1, "edges": ["n7"], "act": act},
            {"id": f"n6_{act}" if act else "n6", "row": _row(2), "col": 2, "lane_slot": 2, "edges": ["n7"], "act": act},
            {"id": f"n7_{act}" if act else "n7", "row": _row(3), "col": 1, "lane_slot": None, "edges": ["nb"], "act": act},
            {"id": f"nb_{act}" if act else "nb", "row": _row(4), "col": 1, "lane_slot": None, "edges": [], "act": act},
        ]
    if shape == "bramble":
        return [
            {"id": f"n0_{act}" if act else "n0", "row": _row(0), "col": 1, "lane_slot": None, "edges": ["n1", "n2", "n3"], "act": act},
            {"id": f"n1_{act}" if act else "n1", "row": _row(1), "col": 0, "lane_slot": 0, "edges": ["n4", "n5"], "act": act},
            {"id": f"n2_{act}" if act else "n2", "row": _row(1), "col": 1, "lane_slot": 1, "edges": ["n5", "n6"], "act": act},
            {"id": f"n3_{act}" if act else "n3", "row": _row(1), "col": 2, "lane_slot": 2, "edges": ["n6"], "act": act},
            {"id": f"n4_{act}" if act else "n4", "row": _row(2), "col": 0, "lane_slot": 0, "edges": ["n8"], "act": act},
            {"id": f"n5_{act}" if act else "n5", "row": _row(2), "col": 1, "lane_slot": 1, "edges": ["n7", "n8"], "act": act},
            {"id": f"n6_{act}" if act else "n6", "row": _row(2), "col": 2, "lane_slot": 2, "edges": ["n7"], "act": act},
            {"id": f"n7_{act}" if act else "n7", "row": _row(3), "col": 2, "lane_slot": 2, "edges": ["n9"], "act": act},
            {"id": f"n8_{act}" if act else "n8", "row": _row(3), "col": 0, "lane_slot": 0, "edges": ["n9"], "act": act},
            {"id": f"n9_{act}" if act else "n9", "row": _row(4), "col": 1, "lane_slot": None, "edges": ["nb"], "act": act},
            {"id": f"nb_{act}" if act else "nb", "row": _row(5), "col": 1, "lane_slot": None, "edges": [], "act": act},
        ]
    # spiral as fallback
    return [
        {"id": f"n0_{act}" if act else "n0", "row": _row(0), "col": 0, "lane_slot": 0, "edges": ["n1"], "act": act},
        {"id": f"n1_{act}" if act else "n1", "row": _row(1), "col": 0, "lane_slot": 0, "edges": ["n2"], "act": act},
        {"id": f"n2_{act}" if act else "n2", "row": _row(2), "col": 0, "lane_slot": 0, "edges": ["n3"], "act": act},
        {"id": f"n3_{act}" if act else "n3", "row": _row(3), "col": 0, "lane_slot": 0, "edges": ["n4"], "act": act},
        {"id": f"n4_{act}" if act else "n4", "row": _row(4), "col": 0, "lane_slot": 0, "edges": ["nb"], "act": act},
        {"id": f"nb_{act}" if act else "nb", "row": _row(5), "col": 0, "lane_slot": None, "edges": [], "act": act},
    ]


def _map_modifier_pool(date_str, modifier_id, pool, active, exclude=None):
    mod = next(m for m in active if m["id"] == modifier_id)
    count = mod.get("count", DEFAULT_SONG_COUNT)
    fallback = False

    if mod["type"] in ("filter", "filter+count"):
        if "predicate" in mod:
            candidates = [s for s in pool if _eval_predicate(s, mod["predicate"])]
        elif "fn" in mod:
            fn = _ALGORITHM_REGISTRY.get(mod["fn"])
            candidates = [s for s in pool if fn and fn(s)] if fn else pool
        else:
            candidates = pool
        if len(candidates) < count:
            return pool, True
        return candidates, False

    if mod["type"] == "identity":
        key = mod.get("key")
        if key in _ALGORITHM_REGISTRY:
            key = _ALGORITHM_REGISTRY[key]
        candidates, fallback = _identity_candidates(
            date_str, pool, key, count, mod.get("min_pool"),
            exclude=exclude, seed_suffix=modifier_id + "map",
        )
        return candidates, fallback

    return pool, False


def _boss_eligible(song):
    return bool(
        (song.get("artist") or "").strip()
        and song.get("year")
    )


# ── Mystery Event Table ──────────────────────────────────────────────────────
MYSTERY_EVENTS = {
    "guess_year": {
        "weight": 3,
        "build": "_build_guess_year",
        "filter": lambda s: bool(s.get("year")),
    },
    "blind_pick": {
        "weight": 3,
        "build": "_build_blind_pick",
        "filter": None,
    },
    "replay": {
        "weight": 2,
        "build": "_build_replay",
        "filter": None,
    },
}


def _mystery_event_seed(date_str, node_id):
    return _date_seed(date_str) + ":" + node_id + ":mystery"


def _pick_mystery_event(date_str, node_id):
    """Pick a mystery event type based on weighted random selection."""
    seed = _mystery_event_seed(date_str, node_id)
    rng = random.Random(seed)
    total_weight = sum(e["weight"] for e in MYSTERY_EVENTS.values())
    pick = rng.uniform(0, total_weight)
    upto = 0
    for event_id, event in MYSTERY_EVENTS.items():
        upto += event["weight"]
        if pick <= upto:
            return event_id
    return list(MYSTERY_EVENTS.keys())[0]


def _build_guess_year(date_str, node_id, pool):
    """Build a guess_year mystery event payload."""
    candidates = [s for s in pool if s.get("year")]
    if not candidates:
        return None
    seed = _mystery_event_seed(date_str, node_id) + ":song"
    rng = random.Random(seed)
    song = rng.choice(candidates)
    return {
        "event_type": "guess_year",
        "event_payload": {
            "cf_id": song["cf_id"],
            "answer_year": int(song["year"]),
        }
    }


def _build_blind_pick(date_str, node_id, pool):
    """Build a blind_pick mystery event payload."""
    if not pool:
        return None
    seed = _mystery_event_seed(date_str, node_id) + ":song"
    rng = random.Random(seed)
    song = rng.choice(pool)
    return {
        "event_type": "blind_pick",
        "event_payload": {
            "cf_id": song["cf_id"],
            "reveal_at_seconds": 5,
        }
    }


def _build_replay(date_str, node_id, pool, history=None):
    """Build a replay mystery event payload from past dailies."""
    conn = _get_conn()
    # Look back up to 30 days for past songs
    past_songs = []
    for days_back in range(1, 31):
        past_date = (date.fromisoformat(date_str) - timedelta(days=days_back)).isoformat()
        row = conn.execute(
            "SELECT songs FROM daily_setlists WHERE date = ?", (past_date,)
        ).fetchone()
        if row:
            try:
                songs = json.loads(row[0])
                for s in songs:
                    if s.get("cf_id"):
                        past_songs.append(s["cf_id"])
            except (json.JSONDecodeError, TypeError):
                continue

    if not past_songs:
        # Fallback to any song from pool
        if not pool:
            return None
        seed = _mystery_event_seed(date_str, node_id) + ":song"
        rng = random.Random(seed)
        song = rng.choice(pool)
        return {
            "event_type": "replay",
            "event_payload": {
                "cf_id": song["cf_id"],
                "originally_seen_date": date_str,
            }
        }

    seed = _mystery_event_seed(date_str, node_id) + ":song"
    rng = random.Random(seed)
    cf_id = rng.choice(past_songs)

    # Find which date this song originally appeared on
    originally_seen = date_str
    for days_back in range(1, 31):
        past_date = (date.fromisoformat(date_str) - timedelta(days=days_back)).isoformat()
        row = conn.execute(
            "SELECT songs FROM daily_setlists WHERE date = ?", (past_date,)
        ).fetchone()
        if row:
            try:
                songs = json.loads(row[0])
                if any(s.get("cf_id") == cf_id for s in songs):
                    originally_seen = past_date
                    break
            except (json.JSONDecodeError, TypeError):
                continue

    return {
        "event_type": "replay",
        "event_payload": {
            "cf_id": cf_id,
            "originally_seen_date": originally_seen,
        }
    }


def _enrich_mystery_node(date_str, node, pool, history=None):
    """Add event_type and event_payload to a mystery node."""
    event_id = _pick_mystery_event(date_str, node["id"])
    event_def = MYSTERY_EVENTS.get(event_id)
    if not event_def:
        return node
    event_data = globals()[event_def["build"]](date_str, node["id"], pool)
    if event_data:
        node["event_type"] = event_data["event_type"]
        node["event_payload"] = event_data["event_payload"]
    return node


ACTS = ['Act 1', 'Act 2', 'Act 3']

ROOM_TYPES = {
    "standard": {
        "label": "Standard",
        "icon": "🎸",
        "color": "#1d4ed8",  # blue
        "description": "Play a song to continue",
        "fn": lambda s: _tuning_family(s) == "standard",
    },
    "elite": {
        "label": "Elite",
        "icon": "⚔️",
        "color": "#dc2626",  # red
        "description": "High-stakes challenge song",
        "fn": lambda s: _boss_eligible(s),
    },
    "treasure": {
        "label": "Treasure",
        "icon": "💎",
        "color": "#f59e0b",  # yellow
        "description": "Bonus item or bonus song",
        "fn": lambda s: True,  # any song
    },
    "rest": {
        "label": "Rest",
        "icon": "🛌",
        "color": "#10b981",  # green
        "description": "Recovery and preparation",
        "fn": lambda s: _tuning_family(s) == "standard" and _song_duration_seconds(s) is not None and _song_duration_seconds(s) < 180,
    },
    "shop": {
        "label": "Shop",
        "icon": "🏪",
        "color": "#8b5cf6",  # purple
        "description": "Purchase upgrades or items",
        "fn": lambda s: _tuning_family(s) == "drop",
    },
    "drop": {
        "label": "Drop",
        "icon": "⬇️",
        "color": "#6366f1",  # indigo
        "fn": lambda s: _tuning_family(s) == "drop",
    },
    "flat": {
        "label": "Flat",
        "icon": "🌍",
        "color": "#14b8a6",  # teal
        "fn": lambda s: _tuning_family(s) == "half_down",
    },
    "sprint": {
        "label": "Sprint",
        "icon": "⚡",
        "color": "#f97316",  # orange
        "fn": lambda s: _song_duration_seconds(s) is not None and _song_duration_seconds(s) < 180,
    },
    "marathon": {
        "label": "Marathon",
        "icon": "🌙",
        "color": "#64748b",  # slate
        "fn": lambda s: _song_duration_seconds(s) is not None and _song_duration_seconds(s) > 300,
    },
    "decade": {
        "label": "Decade",
        "icon": "📻",
        "color": "#ec4899",  # pink
        "dynamic": "decade",
    },
}

def _assign_map_node_types(nodes, rng):
    mystery_count = 0
    elite_count = 0
    for node in nodes:
        if node["id"] == "nb":
            node["type"] = "boss"
        elif node["row"] == 0:
            node["type"] = "forced"  # Start node
        else:
            roll = rng.random()
            if roll < 0.15:
                node["type"] = "elite"
                elite_count += 1
            elif roll < 0.30:
                node["type"] = "treasure"
            elif roll < 0.45:
                node["type"] = "rest"
            elif roll < 0.60:
                node["type"] = "shop"
            elif roll < 0.85:
                node["type"] = "forced"
            elif mystery_count < 2:
                node["type"] = "mystery"
                mystery_count += 1
            else:
                node["type"] = "forced"
    return nodes


def _node_song_need(node):
    if node["type"] == "choice":
        return 3
    if node["type"] == "mystery":
        return 4
    if node["type"] == "forced":
        return 1
    if node["type"] == "elite":
        return 5
    if node["type"] == "treasure":
        return 2
    if node["type"] == "rest":
        return 0  # rest rooms do not require a song
    if node["type"] == "shop":
        return 0
    return 0


def _sample_unused(rng, candidates, count, used_cf_ids):
    available = [s for s in candidates if s.get("cf_id") not in used_cf_ids]
    if len(available) < count:
        return None
    picked = rng.sample(available, count)
    used_cf_ids.update(s["cf_id"] for s in picked)
    return picked


def _song_decade(song):
    try:
        y = int(song.get("year") or 0)
    except (ValueError, TypeError):
        return None
    if not y:
        return None
    return (y // 10) * 10


def _resolve_lane_candidates(lane_id, lane_def, pool, need, rng, seed_suffix):
    if lane_def.get("dynamic") == "decade":
        groups = {}
        for song in pool:
            decade = _song_decade(song)
            if decade is not None:
                groups.setdefault(decade, []).append(song)
        eligible = [d for d, songs in groups.items() if len(songs) >= need]
        if not eligible:
            return None, None, None
        local_rng = random.Random(seed_suffix + lane_id)
        local_rng.shuffle(eligible)
        decade = eligible[0]
        resolved_id = f"decade_{decade}s"
        return resolved_id, lane_def.get("icon", ""), groups[decade]
    return lane_id, lane_def.get("icon", ""), [s for s in pool if lane_def["fn"](s)]


def _build_spiral_map(date_str, modifier_id, pool, active, fallback):
    rng = random.Random(_date_seed(date_str) + modifier_id + "mapfallback")
    # Use fork shape for multiple branching tracks instead of linear spiral
    nodes = _assign_map_node_types(_map_shape_template("fork"), rng)
    boss_pool = [s for s in pool if _boss_eligible(s)] or pool
    if not boss_pool:
        return None, [], True

    boss = rng.choice(boss_pool)
    used_cf_ids = {boss["cf_id"]}
    songs = {boss["cf_id"]: boss}

    # Assign multiple lanes from MAP_LANES for variety
    lane_ids = [lid for lid in MAP_LANES if lid != "decade"]
    rng.shuffle(lane_ids)
    lane_slots = sorted({n["lane_slot"] for n in nodes if n.get("lane_slot") is not None})
    slot_to_lane = {slot: lane_ids[i % len(lane_ids)] for i, slot in enumerate(lane_slots)} if lane_ids else {}

    for node in nodes:
        slot = node.pop("lane_slot", None)
        if node["id"] == "nb":
            node["lane"] = None
            node["cf_id"] = boss["cf_id"]
            continue
        node["lane"] = slot_to_lane.get(slot, "standard")
        need = _node_song_need(node)
        if need == 0:
            continue
        lane_def = MAP_LANES.get(node["lane"], {})
        lane_pool = pool if not lane_def.get("fn") else [s for s in pool if lane_def["fn"](s)]
        picked = _sample_unused(rng, lane_pool, need, used_cf_ids)
        if not picked:
            picked = _sample_unused(rng, pool, need, used_cf_ids)
        if not picked:
            return None, [], True
        for song in picked:
            songs[song["cf_id"]] = song
        if node["type"] == "choice":
            node["cf_ids"] = [s["cf_id"] for s in picked]
        elif node["type"] == "mystery":
            node["cf_pool"] = [s["cf_id"] for s in picked]
            node = _enrich_mystery_node(date_str, node, pool)
        else:
            node["cf_id"] = picked[0]["cf_id"]

    lanes = {lid: MAP_LANES[lid]["icon"] for lid in lane_ids if lid in MAP_LANES}
    return {
        "shape": "fork",
        "start": "n0",
        "boss": "nb",
        "nodes": nodes,
        "lanes": lanes,
    }, list(songs.values()), fallback


ACTS = ['Act 1', 'Act 2', 'Act 3']


def _build_map(date_str, modifier_id, pool, active, exclude=None):
    modifier_pool, modifier_fallback = _map_modifier_pool(date_str, modifier_id, pool, active, exclude=exclude)

    mod = next(m for m in active if m["id"] == modifier_id)
    collapse_to_spiral = mod["type"] == "identity"
    if collapse_to_spiral and len(modifier_pool) < DEFAULT_SONG_COUNT:
        collapse_to_spiral = False
    rng = random.Random(_date_seed(date_str) + modifier_id + "map")
    shape = "spiral" if collapse_to_spiral else _weighted_choice(rng, MAP_SHAPE_WEIGHTS)
    nodes = _assign_map_node_types(_map_shape_template(shape), rng)

    boss_pool = [s for s in modifier_pool if _boss_eligible(s)]
    if not boss_pool:
        return _build_spiral_map(date_str, modifier_id, pool, active, True)
    boss = rng.choice(boss_pool)
    used_cf_ids = {boss["cf_id"]}

    lane_slots = sorted({n["lane_slot"] for n in nodes if n.get("lane_slot") is not None})
    if collapse_to_spiral:
        lane_ids = [modifier_id]
        lane_defs = {modifier_id: {"icon": mod.get("icon", ""), "fn": lambda s: True}}
    else:
        lane_defs = MAP_LANES
        lane_need = {slot: 0 for slot in lane_slots}
        for node in nodes:
            slot = node.get("lane_slot")
            if slot is not None:
                lane_need[slot] += _node_song_need(node)

        eligible = []
        lane_candidate_map = {}
        lane_icon_map = {}
        required_lane_capacity = max(lane_need.values() or [1])
        for lane_id, lane in lane_defs.items():
            resolved_id, icon, lane_pool = _resolve_lane_candidates(
                lane_id, lane, [s for s in modifier_pool if s.get("cf_id") != boss["cf_id"]],
                required_lane_capacity, rng, _date_seed(date_str) + modifier_id + "lane",
            )
            if resolved_id and len(lane_pool) >= required_lane_capacity:
                eligible.append(resolved_id)
                lane_candidate_map[resolved_id] = lane_pool
                lane_icon_map[resolved_id] = icon
        rng.shuffle(eligible)
        if len(eligible) < len(lane_slots):
            return _build_spiral_map(date_str, modifier_id, pool, active, True)
        lane_ids = eligible[:len(lane_slots)]

    slot_to_lane = {slot: lane_ids[i] for i, slot in enumerate(lane_slots)}
    songs = {boss["cf_id"]: boss}

    # Assign ACT to forced nodes based on row (first row = ACT 1, second = ACT 2, etc.)
    act_number = 1
    forced_nodes_in_row = {}
    for node in nodes:
        if node.get("type") == "forced":
            row = node.get("row", 0)
            forced_nodes_in_row.setdefault(row, []).append(node)
    
    # Tag the start forced node as Act 1 and the boss as Act 2.
    # Lane-internal forced nodes (e.g. drop lane's mid-forced) don't get
    # act labels — they're part of a single act, not act dividers.
    for node in nodes:
        if node.get("type") == "forced" and node.get("row") == 0:
            node["act"] = "AC_1"
        elif node.get("type") == "boss":
            node["act"] = "AC_2"

    for node in nodes:
        slot = node.pop("lane_slot", None)
        lane_id = slot_to_lane.get(slot)
        node["lane"] = lane_id
        if node["id"] == "nb":
            node["cf_id"] = boss["cf_id"]
            continue

        need = _node_song_need(node)
        if need == 0:
            continue
        if lane_id and not collapse_to_spiral:
            candidates = lane_candidate_map[lane_id]
        else:
            candidates = modifier_pool
        picked = _sample_unused(rng, candidates, need, used_cf_ids)
        if not picked:
            return _build_spiral_map(date_str, modifier_id, pool, active, True)
        for song in picked:
            songs[song["cf_id"]] = song
        if node["type"] == "choice":
            node["cf_ids"] = [s["cf_id"] for s in picked]
        elif node["type"] == "mystery":
            node["cf_pool"] = [s["cf_id"] for s in picked]
            node = _enrich_mystery_node(date_str, node, pool)
        else:
            node["cf_id"] = picked[0]["cf_id"]

    # Build nodes_by_lane for lane tracking
    nodes_by_lane = {}
    for node in nodes:
        lane = node.get("lane")
        if lane:
            if lane not in nodes_by_lane:
                nodes_by_lane[lane] = {"first_node": node, "count": 0}
            nodes_by_lane[lane]["count"] += 1

    # Build lanes by ACT type
    lanes = {}
    lane_act_map = {}
    if collapse_to_spiral:
        lanes[modifier_id] = mod.get("icon", "")
    else:
        # Group lanes by ACT type for proper routing
        for lane_id in lane_ids:
            # Get the first node to determine ACT type
            lane_info = nodes_by_lane.get(lane_id, {})
            sample_node = lane_info.get("first_node")
            if sample_node and sample_node.get("type") in ["forced", "elite", "treasure", "rest", "shop"]:
                lane_act_map[lane_id] = sample_node.get("act", "AC_1")
            else:
                lane_act_map[lane_id] = "AC_1"
            lanes[lane_id] = lane_icon_map[lane_id]

    return {
        "shape": shape,
        "start": "n0",
        "boss": "nb",
        "nodes": nodes,
        "lanes": lanes,
        "lane_acts": lane_act_map,
        "acts": {"min": 1, "max": act_number},
    }, list(songs.values()), modifier_fallback


def _song_by_id(songs):
    return {s.get("cf_id"): s for s in songs if s.get("cf_id") is not None}


def _node_by_id(map_data):
    return {n.get("id"): n for n in (map_data or {}).get("nodes", [])}


def _node_song_ids(node):
    if not node:
        return []
    if node.get("type") == "choice":
        return list(node.get("cf_ids") or [])
    if node.get("type") == "mystery":
        return list(node.get("cf_pool") or [])
    cf_id = node.get("cf_id")
    return [cf_id] if cf_id is not None else []


def _client_install_id(request=None, data=None):
    if data and data.get("install_id"):
        return str(data.get("install_id"))[:80]
    if request is not None:
        install_id = request.headers.get("X-Daily-Install-Id") or request.query_params.get("install_id")
        if install_id:
            return str(install_id)[:80]
    return None


def _inventory_payload(conn, install_id):
    if not install_id:
        return {"items": [], "counts": {}, "tokens": 0, "cosmetics": [], "equipped": {}}
    row = conn.execute(
        "SELECT items, tokens, cosmetics, equipped FROM daily_inventory WHERE install_id = ?", (install_id,)
    ).fetchone()
    if not row:
        with _lock:
            conn.execute(
                "INSERT OR IGNORE INTO daily_inventory (install_id, items, updated_at, tokens, cosmetics, equipped) VALUES (?, '[]', datetime('now'), 0, '[]', '{}')",
                (install_id,),
            )
            conn.commit()
        return {"items": [], "counts": {}, "tokens": 0, "cosmetics": [], "equipped": {}}
    try:
        items = json.loads(row[0] or "[]")
    except Exception:
        items = []
    tokens = row[1] or 0
    try:
        cosmetics = json.loads(row[2] or "[]")
    except Exception:
        cosmetics = []
    try:
        equipped = json.loads(row[3] or "{}")
    except Exception:
        equipped = {}

    counts = {}
    for item in items:
        counts[item] = counts.get(item, 0) + 1
    return {"items": items, "counts": counts, "tokens": tokens, "cosmetics": cosmetics, "equipped": equipped}


def _map_cleared_node_ids(conn, date_str):
    return {
        r[0] for r in conn.execute(
            "SELECT node_id FROM daily_completions WHERE date = ? AND node_id IS NOT NULL",
            (date_str,),
        ).fetchall() if r[0]
    }


def _map_committed_node_ids(conn, date_str, install_id):
    if not install_id:
        return set()
    return {
        r[0] for r in conn.execute(
            "SELECT node_id FROM daily_node_commits WHERE date = ? AND install_id = ?",
            (date_str, install_id),
        ).fetchall() if r[0]
    }


def _get_or_generate_setlist(conn, date_str, plugin_dir):
    """Get or generate a setlist for any date. Used by peek endpoints for foresight."""
    row = conn.execute(
        "SELECT day_name, modifier, songs, song_count, map, fallback, lane_paths, pool_stamp FROM daily_setlists WHERE date = ?",
        (date_str,),
    ).fetchone()
    if row:
        day_name, modifier_id, songs_json, song_count, map_json, fallback_int, lane_paths_json, pool_stamp = row
        songs = json.loads(songs_json)
        map_data = json.loads(map_json) if map_json else None
        return {
            "day_name": day_name,
            "modifier_id": modifier_id,
            "songs": songs,
            "song_count": song_count,
            "map": map_data,
            "fallback": bool(fallback_int),
            "lane_paths": json.loads(lane_paths_json) if lane_paths_json else None,
            "pool_stamp": pool_stamp,
        }

    # Generate if not present
    try:
        active = _get_active_modifier(date_str)
    except RuntimeError:
        return None
    pool = _load_pool(date_str, plugin_dir)
    if not pool:
        return None
    modifier_id = _pick_modifier(date_str, active)
    active_pool = _daily_active_pool(conn, date_str, pool)
    exclude = _daily_artist_exclude(conn, date_str, modifier_id)
    target_date = date.fromisoformat(date_str)
    
    # Build lane_paths for generated setlist
    lane_paths = None
    if target_date >= MAP_MODE_START:
        map_data, songs, fallback = _build_map(date_str, modifier_id, active_pool, active, exclude=exclude)
        song_count = 1
        # Extract lane_paths from map_data
        if map_data and map_data.get("nodes"):
            nodes_by_lane = {}
            for node in map_data.get("nodes", []):
                lane = node.get("lane")
                if lane:
                    if lane not in nodes_by_lane:
                        nodes_by_lane[lane] = []
                    nodes_by_lane[lane].append(node["id"])
            lane_paths = nodes_by_lane
    else:
        songs, song_count, fallback = _select_songs(date_str, modifier_id, active_pool, active, exclude=exclude)
        map_data = None
    mod = next(m for m in active if m["id"] == modifier_id)
    day_name = _day_name(date_str, mod, songs)

    pool_stamp = _get_pool_stamp(date_str)

    with _lock:
        conn.execute(
            "INSERT OR IGNORE INTO daily_setlists "
            "(date, day_name, modifier, songs, song_count, map, fallback, lane_paths, pool_stamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (date_str, day_name, modifier_id, json.dumps(songs), song_count,
             json.dumps(map_data) if map_data else None, 1 if fallback else 0,
             json.dumps(lane_paths) if lane_paths else None, pool_stamp),
        )
        conn.commit()

    return {
        "day_name": day_name,
        "modifier_id": modifier_id,
        "songs": songs,
        "song_count": song_count,
        "map": map_data,
        "fallback": fallback,
        "lane_paths": lane_paths,
        "pool_stamp": pool_stamp,
    }


def _song_liner_notes(song):
    """Generate liner notes for a song from pool metadata."""
    title = song.get("title", "Unknown")
    artist = song.get("artist", "Unknown")
    year = song.get("year", "")
    album = song.get("album", "")
    trivia = song.get("trivia", "")

    lines = []
    if trivia:
        lines.append(trivia)
    else:
        if year and album:
            lines.append(f"Released {year} on {album}.")
        elif year:
            lines.append(f"Released in {year}.")
        if artist:
            origin = song.get("artist_origin", "")
            if origin:
                lines.append(f"Artist origin: {origin}.")

    # Add duration if available
    duration = song.get("duration")
    if duration:
        try:
            secs = int(float(duration))
            m, s = divmod(secs, 60)
            lines.append(f"Duration: {m}:{s:02d}")
        except (ValueError, TypeError):
            pass

    return {
        "title": title,
        "artist": artist,
        "year": year,
        "album": album,
        "trivia": trivia,
        "notes": " ".join(lines) if lines else f"{title} by {artist}.",
        "album_art": song.get("album_art", ""),
    }


def _map_available_state(conn, date_str, map_data, install_id=None):
    nodes = _node_by_id(map_data)
    cleared = _map_cleared_node_ids(conn, date_str)
    committed = _map_committed_node_ids(conn, date_str, install_id)
    reachable = {map_data.get("start")}
    for node_id in cleared:
        node = nodes.get(node_id)
        if node:
            reachable.update(node.get("edges") or [])

    locked = set()
    for node_id in committed:
        node = nodes.get(node_id)
        if not node:
            continue
        row = node.get("row")
        locked.update(
            n["id"] for n in nodes.values()
            if n.get("row") == row and n.get("id") != node_id and n.get("id") not in cleared and n.get("id") not in committed
        )

    available = (reachable | (committed - cleared)) - cleared - locked
    available = {n for n in available if n in nodes}
    boss_id = map_data.get("boss")
    boss_revealed = boss_id in available or boss_id in cleared or boss_id in committed
    return {
        "cleared_node_ids": sorted(cleared),
        "committed_node_ids": sorted(committed),
        "available_node_ids": sorted(available),
        "locked_node_ids": sorted(locked),
        "boss_revealed": boss_revealed,
        "is_complete": boss_id in cleared,
    }


def _debug_map_state(map_data, cleared=None, committed=None):
    nodes = _node_by_id(map_data)
    cleared = set(cleared or [])
    committed = set(committed or [])
    reachable = {map_data.get("start")}
    for node_id in cleared:
        node = nodes.get(node_id)
        if node:
            reachable.update(node.get("edges") or [])

    locked = set()
    for node_id in committed:
        node = nodes.get(node_id)
        if not node:
            continue
        row = node.get("row")
        locked.update(
            n["id"] for n in nodes.values()
            if n.get("row") == row and n.get("id") != node_id and n.get("id") not in cleared and n.get("id") not in committed
        )

    available = (reachable | (committed - cleared)) - cleared - locked
    available = {n for n in available if n in nodes}
    boss_id = map_data.get("boss")
    boss_revealed = boss_id in available or boss_id in cleared or boss_id in committed
    return {
        "cleared_node_ids": sorted(cleared),
        "committed_node_ids": sorted(committed),
        "available_node_ids": sorted(available),
        "locked_node_ids": sorted(locked),
        "boss_revealed": boss_revealed,
        "is_complete": boss_id in cleared,
    }


def _apply_boss_reroll(conn, date_str, map_data, songs, install_id):
    if not install_id or not map_data:
        return map_data, songs, False
    row = conn.execute(
        "SELECT rerolled_cf_id FROM daily_boss_rerolls WHERE install_id = ? AND date = ?",
        (install_id, date_str),
    ).fetchone()
    if not row:
        return map_data, songs, False
    rerolled_cf_id = row[0]
    song_map = _song_by_id(songs)
    if rerolled_cf_id not in song_map:
        pool = _load_pool(date_str, Path(__file__).parent)
        for song in pool:
            if song.get("cf_id") == rerolled_cf_id:
                song_map[rerolled_cf_id] = song
                songs = list(songs) + [song]
                break
    map_copy = json.loads(json.dumps(map_data))
    for node in map_copy.get("nodes", []):
        if node.get("id") == map_copy.get("boss"):
            node["cf_id"] = rerolled_cf_id
            break
    return map_copy, songs, True


def _enrich_songs(meta_db, songs, done_cf_ids=None):
    done_cf_ids = done_cf_ids or set()
    enriched = []
    for song in songs:
        s = dict(song)
        s["local_filename"] = _find_locally(meta_db, s)
        s["has_locally"] = s["local_filename"] is not None
        s["done"] = s.get("cf_id") in done_cf_ids
        enriched.append(s)
    return enriched


def _is_day_complete(conn, date_str):
    row = conn.execute(
        "SELECT song_count, map FROM daily_setlists WHERE date = ?", (date_str,)
    ).fetchone()
    if not row:
        return False
    song_count, map_json = row
    if map_json:
        try:
            map_data = json.loads(map_json)
        except Exception:
            return False
        return map_data.get("boss") in _map_cleared_node_ids(conn, date_str)
    done = conn.execute(
        "SELECT COUNT(*) FROM daily_completions WHERE date = ?", (date_str,)
    ).fetchone()[0]
    return done >= song_count


def _compute_streak_including_today(conn, today_str):
    d = date.fromisoformat(today_str)
    streak = 0
    while _is_day_complete(conn, d.isoformat()):
        streak += 1
        d -= timedelta(days=1)
    return streak


def _award_inventory_for_completion(conn, install_id, today_str):
    if not install_id:
        return
    inv = _inventory_payload(conn, install_id)
    row = conn.execute(
        "SELECT items, last_streak_milestone, starter_awarded FROM daily_inventory WHERE install_id = ?",
        (install_id,),
    ).fetchone()
    if not row:
        return
    items = inv["items"]
    milestone = int(row[1] or 0)
    starter_awarded = int(row[2] or 0)
    changed = False
    if not starter_awarded:
        items.append(BOSS_REROLL_ITEM)
        starter_awarded = 1
        changed = True
    streak = _compute_streak_including_today(conn, today_str)
    next_milestone = streak // 7
    if next_milestone > milestone:
        items.extend([BOSS_REROLL_ITEM] * (next_milestone - milestone))
        milestone = next_milestone
        changed = True
    if changed:
        with _lock:
            conn.execute(
                "UPDATE daily_inventory SET items = ?, last_streak_milestone = ?, starter_awarded = ?, updated_at = datetime('now') WHERE install_id = ?",
                (json.dumps(items), milestone, starter_awarded, install_id),
            )
            conn.commit()

    # Award tokens for completion
    # 2 tokens per song completed
    today_completions = conn.execute(
        "SELECT COUNT(*) FROM daily_completions WHERE date = ? AND install_id = ?",
        (today_str, install_id),
    ).fetchone()[0]

    # Check if this is a boss completion (map mode)
    map_row = conn.execute(
        "SELECT map FROM daily_setlists WHERE date = ?", (today_str,)
    ).fetchone()
    is_boss_clear = False
    if map_row and map_row[0]:
        try:
            map_data = json.loads(map_row[0])
            boss_id = map_data.get("boss")
            cleared = _map_cleared_node_ids(conn, today_str)
            is_boss_clear = boss_id in cleared
        except Exception:
            pass

    tokens_earned = today_completions * 2
    if is_boss_clear:
        tokens_earned += 5  # Boss completion bonus

    # Check for full clear (all nodes cleared in map mode)
    if map_data and is_boss_clear:
        nodes = map_data.get("nodes", [])
        if cleared and len(cleared) >= len(nodes) - 1:  # all except boss counted separately
            tokens_earned += 5  # Full clear bonus

    if tokens_earned > 0:
        _award_tokens(conn, install_id, today_str, tokens_earned, "daily_completion")


def _lane_popularity(entries):
    counts = {}
    for entry in entries or []:
        lane = entry.get("lane_taken")
        if lane:
            counts[lane] = counts.get(lane, 0) + 1
    total = sum(counts.values())
    if not total:
        return []
    return [
        {"lane": lane, "count": count, "percent": round((count / total) * 100)}
        for lane, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]


def _daily_active_pool(conn, date_str, pool):
    used_cf_ids = set()
    current = date.fromisoformat(date_str)
    for i in range(1, 15):
        past = (current - timedelta(days=i)).isoformat()
        past_row = conn.execute(
            "SELECT songs FROM daily_setlists WHERE date = ?", (past,)
        ).fetchone()
        if past_row:
            for s in json.loads(past_row[0]):
                used_cf_ids.add(s["cf_id"])
    fresh_pool = [s for s in pool if s["cf_id"] not in used_cf_ids]
    return fresh_pool if len(fresh_pool) >= DEFAULT_SONG_COUNT else pool


def _daily_artist_exclude(conn, date_str, modifier_id):
    if modifier_id != "artist_takeover":
        return None
    exclude = set()
    current = date.fromisoformat(date_str)
    for i in range(1, 15):
        past = (current - timedelta(days=i)).isoformat()
        past_row = conn.execute(
            "SELECT modifier, songs FROM daily_setlists WHERE date = ?", (past,)
        ).fetchone()
        if past_row and past_row[0] == "artist_takeover":
            past_songs = json.loads(past_row[1])
            if past_songs:
                exclude.add((past_songs[0].get("artist") or "").lower())
    return exclude


# ── Local library matching ────────────────────────────────────────────────────
def _normalize_title(title):
    title = (title or "").lower()
    title = re.sub(r"\s*\(.*?\)", "", title)
    title = re.sub(r"[?!\.,:;'\"\(\)]", "", title)
    title = re.sub(r"\s+", " ", title)
    return title.strip()


def _find_locally(meta_db, song):
    norm = _normalize_title(song.get("title"))
    artist_norm = (song.get("artist") or "").lower()
    rows = meta_db.conn.execute(
        "SELECT filename, title, artist FROM songs "
        "WHERE artist LIKE ? COLLATE NOCASE LIMIT 500",
        (f"%{artist_norm}%",),
    ).fetchall()
    for row in rows:
        fn, local_title, local_artist = row
        local_norm = _normalize_title(local_title)
        if local_norm == norm:
            return fn
    return None


# ── Streak ────────────────────────────────────────────────────────────────────
def _compute_streak(conn, today_str):
    d = date.fromisoformat(today_str) - timedelta(days=1)
    streak = 0
    while True:
        ds = d.isoformat()
        row = conn.execute(
            "SELECT song_count FROM daily_setlists WHERE date = ?", (ds,)
        ).fetchone()
        if not row:
            break
        done = conn.execute(
            "SELECT COUNT(*) FROM daily_completions WHERE date = ?", (ds,)
        ).fetchone()[0]
        if done < row[0]:
            break
        streak += 1
        d -= timedelta(days=1)
    return streak


def _compute_committed_lane(conn, date_str, install_id):
    """Return the lane whose path is fully covered by completions, or 'mixed', or None."""
    row = conn.execute(
        "SELECT map, lane_paths FROM daily_setlists WHERE date = ?", (date_str,)
    ).fetchone()
    if not row:
        return None
    map_json, lane_paths_json = row
    if not map_json:
        return None
    try:
        map_data = json.loads(map_json)
        lane_paths = json.loads(lane_paths_json) if lane_paths_json else {}
    except Exception:
        return None

    if not lane_paths:
        return None

    cleared = _map_cleared_node_ids(conn, date_str)
    boss_id = map_data.get("boss")
    if boss_id not in cleared:
        return None

    matched_lanes = set()
    for lane, path in lane_paths.items():
        if all(nid in cleared for nid in path):
            matched_lanes.add(lane)

    if len(matched_lanes) == 1:
        return matched_lanes.pop()
    elif len(matched_lanes) > 1:
        return "mixed"
    return None


def _compute_lane_streak(conn, today_str, lane):
    """Walk backwards day-by-day counting consecutive days with committed_lane == lane."""
    d = date.fromisoformat(today_str) - timedelta(days=1)
    streak = 0
    while True:
        ds = d.isoformat()
        row = conn.execute(
            "SELECT song_count FROM daily_setlists WHERE date = ?", (ds,)
        ).fetchone()
        if not row:
            break
        committed = conn.execute(
            "SELECT committed_lane FROM daily_completions WHERE date = ? AND committed_lane IS NOT NULL LIMIT 1",
            (ds,),
        ).fetchone()
        if not committed or committed[0] != lane:
            break
        streak += 1
        d -= timedelta(days=1)
    return streak


# ── Supabase ──────────────────────────────────────────────────────────────────
def _supabase_get(path, params=None):
    from urllib.parse import urlencode
    url = SUPABASE_URL + path
    if params:
        url += "?" + urlencode(params)
    req = urllib.request.Request(url)
    req.add_header("apikey", SUPABASE_ANON_KEY)
    req.add_header("Authorization", f"Bearer {SUPABASE_ANON_KEY}")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def _supabase_post(path, body):
    url = SUPABASE_URL + path
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("apikey", SUPABASE_ANON_KEY)
    req.add_header("Authorization", f"Bearer {SUPABASE_ANON_KEY}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "return=minimal")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status


def _get_client_ip(request):
    xff = request.headers.get("X-Forwarded-For")
    if xff:
        return xff.split(",")[0].strip()
    return request.remote_addr or "unknown"


def _validate_display_name(name):
    if not name or len(name) < NAME_MIN_LENGTH or len(name) > NAME_MAX_LENGTH:
        return False, f"Name must be {NAME_MIN_LENGTH}-{NAME_MAX_LENGTH} characters"
    if not re.match(r"^[a-zA-Z0-9 ]+$", name):
        return False, "Name can only contain letters, numbers, and spaces"
    # Profanity enforcement lives in a Supabase trigger on the leaderboard
    # table so the blocklist never touches this repo.
    return True, None


def _compute_streak_from_supabase(ip, today):
    if not SUPABASE_URL or SUPABASE_URL.startswith("https://YOURPROJECT"):
        return 0
    if ip == "unknown":
        return 0
    streak = 0
    check_date = today - timedelta(days=1)
    for _ in range(STREAK_LOOKBACK_DAYS):
        entries = _supabase_get(
            "/rest/v1/leaderboard",
            {
                "date": f"eq.{check_date.isoformat()}",
                "ip": f"eq.{ip}",
                "select": "date",
            },
        )
        if not entries:
            break
        streak += 1
        check_date -= timedelta(days=1)
    return streak


def _check_ip_rate_limit(ip, target_date):
    if not SUPABASE_URL or SUPABASE_URL.startswith("https://YOURPROJECT"):
        return True
    if ip == "unknown":
        return True
    entries = _supabase_get(
        "/rest/v1/leaderboard",
        {
            "date": f"eq.{target_date.isoformat()}",
            "ip": f"eq.{ip}",
            "select": "ip",
        },
    )
    return len(entries) < IP_DAILY_LIMIT


# ── Supabase mirror push/pull (ADR-0001) ────────────────────────────
# Mirror schema (create manually in Supabase SQL editor):
#
# CREATE TABLE inventory (
#     recovery_code TEXT PRIMARY KEY,
#     tokens INTEGER NOT NULL DEFAULT 0,
#     cosmetics JSONB NOT NULL DEFAULT '[]',
#     equipped JSONB NOT NULL DEFAULT '{}',
#     stamps JSONB NOT NULL DEFAULT '[]',
#     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
# );
#
# CREATE TABLE passport_entries (
#     recovery_code TEXT NOT NULL,
#     date TEXT NOT NULL,
#     day_name TEXT,
#     modifier TEXT,
#     lane TEXT,
#     boss_done BOOLEAN NOT NULL DEFAULT FALSE,
#     full_clear BOOLEAN NOT NULL DEFAULT FALSE,
#     streak_at INTEGER,
#     PRIMARY KEY (recovery_code, date)
# );
#
# Both tables should allow public insert/update via anon key (RLS off, or
# permissive policy). Same trust model as the existing leaderboard table.

logger = logging.getLogger(__name__)

_mirror_timer = None
_mirror_timer_lock = threading.Lock()


def _mirror_push(install_id: str) -> bool:
    """Best-effort push of local inventory + recent passport entries to Supabase.
    Returns True on success, False on any failure (logged but not raised)."""
    if not SUPABASE_URL or SUPABASE_URL.startswith("https://YOURPROJECT"):
        return False
    conn = _get_conn()
    code = _get_or_create_recovery_code(conn, install_id)
    inv = conn.execute(
        "SELECT tokens, cosmetics, equipped FROM daily_inventory WHERE install_id = ?",
        (install_id,)
    ).fetchone()
    if not inv:
        return False
    stamps = [r[0] for r in conn.execute(
        "SELECT stamp_id FROM daily_stamps WHERE install_id = ?", (install_id,)
    ).fetchall()]
    payload = {
        "recovery_code": code,
        "tokens": inv[0],
        "cosmetics": json.loads(inv[1] or "[]"),
        "equipped": json.loads(inv[2] or "{}"),
        "stamps": stamps,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }
    try:
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/inventory",
            headers={
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates",
            },
            json=payload,
            timeout=4,
        )
        if r.status_code >= 400:
            logger.warning("mirror push failed: %s %s", r.status_code, r.text[:200])
            return False
    except Exception as e:
        logger.warning("mirror push exception: %s", e)
        return False

    # Passport entries: push today's row only (idempotent upsert)
    today = datetime.utcnow().date().isoformat()
    today_row = conn.execute("""
        SELECT day_name, modifier, committed_lane,
               (SELECT COUNT(*) FROM daily_completions WHERE date = ds.date AND install_id = ?) AS done_count,
               song_count
        FROM daily_setlists ds WHERE date = ?
    """, (install_id, today)).fetchone()
    if today_row and today_row[3] > 0:
        passport_payload = {
            "recovery_code": code,
            "date": today,
            "day_name": today_row[0],
            "modifier": today_row[1],
            "lane": today_row[2],
            "boss_done": today_row[3] >= today_row[4],
            "full_clear": False,
            "streak_at": _compute_streak(conn, today),
        }
        try:
            requests.post(
                f"{SUPABASE_URL}/rest/v1/passport_entries",
                headers={
                    "apikey": SUPABASE_ANON_KEY,
                    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
                    "Content-Type": "application/json",
                    "Prefer": "resolution=merge-duplicates",
                },
                json=passport_payload,
                timeout=4,
            )
        except Exception as e:
            logger.warning("passport push exception: %s", e)
    return True


def _mirror_push_debounced(install_id: str):
    global _mirror_timer
    with _mirror_timer_lock:
        if _mirror_timer is not None:
            _mirror_timer.cancel()
        _mirror_timer = threading.Timer(2.0, _mirror_push, args=[install_id])
        _mirror_timer.daemon = True
        _mirror_timer.start()


def _mirror_pull(code: str) -> dict | None:
    """Fetch inventory row for a recovery code. Returns None on failure or 404."""
    if not SUPABASE_URL or SUPABASE_URL.startswith("https://YOURPROJECT"):
        return None
    try:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/inventory?recovery_code=eq.{code}",
            headers={
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
            },
            timeout=4,
        )
        if r.status_code != 200:
            return None
        rows = r.json()
        return rows[0] if rows else None
    except Exception:
        return None


# ── Routes ────────────────────────────────────────────────────────────────────
def setup(app, context):
    global _db_path
    config_dir = context["config_dir"]
    _db_path = str(config_dir / "the_daily.db")
    meta_db = context["meta_db"]
    plugin_dir = Path(__file__).parent

    @app.get("/api/plugins/the_daily/today")
    def get_today(request: Request):
        today = _get_today().isoformat()
        real_today = today
        today_date = date.fromisoformat(today)
        install_id = _client_install_id(request=request)
        debug_map = _DEBUG_ENABLED and request.query_params.get("debug_map") in ("1", "true", "yes")
        if debug_map and request.query_params.get("debug_date"):
            try:
                today = date.fromisoformat(request.query_params.get("debug_date")).isoformat()
                today_date = date.fromisoformat(today)
            except Exception:
                today = real_today
                today_date = date.fromisoformat(today)
        conn = _get_conn()

        try:
            active = _get_active_modifier(today)
        except RuntimeError as e:
            msg = str(e)
            if msg == "offline":
                return {"error": "offline"}
            if msg.startswith("update_required:"):
                return {"error": "update_required", "min_version": msg.split(":", 1)[1]}
            raise

        row = conn.execute(
            "SELECT day_name, modifier, songs, song_count, map, fallback, lane_paths, pool_stamp FROM daily_setlists WHERE date = ?",
            (today,),
        ).fetchone()

        fallback = False
        map_data = None
        if debug_map:
            pool = _load_pool(today, plugin_dir)
            if not pool:
                return {"error": "Song pool is empty. Run build_pool.py to populate it."}
            modifier_id = _pick_modifier(today, active)
            active_pool = _daily_active_pool(conn, today, pool)
            exclude = _daily_artist_exclude(conn, today, modifier_id)
            mod = next(m for m in active if m["id"] == modifier_id)
            map_data, songs, fallback = _build_map(today, modifier_id, active_pool, active, exclude=exclude)
            song_count = 1
            day_name = _day_name(today, mod, songs)
            pool_stamp = _get_pool_stamp(today)
        elif row:
            day_name, modifier_id, songs_json, song_count, map_json, fallback_int, lane_paths_json, pool_stamp = row
            songs = json.loads(songs_json)
            map_data = json.loads(map_json) if map_json else None
            fallback = bool(fallback_int)
            mod = next((m for m in active if m["id"] == modifier_id), None)
        else:
            pool = _load_pool(today, plugin_dir)
            if not pool:
                return {"error": "Song pool is empty. Run build_pool.py to populate it."}

            modifier_id = _pick_modifier(today, active)
            mod = next(m for m in active if m["id"] == modifier_id)

            active_pool = _daily_active_pool(conn, today, pool)
            exclude = _daily_artist_exclude(conn, today, modifier_id)
            if today_date >= MAP_MODE_START:
                map_data, songs, fallback = _build_map(today, modifier_id, active_pool, active, exclude=exclude)
                song_count = 1
            else:
                songs, song_count, fallback = _select_songs(today, modifier_id, active_pool, active, exclude=exclude)
            day_name = _day_name(today, mod, songs)

            # Build lane_paths from map_data for committed lane computation
            lane_paths = {}
            if map_data and map_data.get("nodes"):
                nodes_by_lane = {}
                for node in map_data.get("nodes", []):
                    lane = node.get("lane")
                    if lane:
                        if lane not in nodes_by_lane:
                            nodes_by_lane[lane] = []
                        nodes_by_lane[lane].append(node["id"])
                lane_paths = nodes_by_lane

            pool_stamp = _get_pool_stamp(today)

            with _lock:
                conn.execute(
                    "INSERT OR IGNORE INTO daily_setlists "
                    "(date, day_name, modifier, songs, song_count, map, fallback, lane_paths, pool_stamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (today, day_name, modifier_id, json.dumps(songs), song_count, json.dumps(map_data) if map_data else None, 1 if fallback else 0, json.dumps(lane_paths) if lane_paths else None, pool_stamp),
                )
                conn.commit()

        map_data, songs, used_reroll = (map_data, songs, False) if debug_map else _apply_boss_reroll(conn, today, map_data, songs, install_id)

        done_ids = set() if debug_map else {r[0] for r in conn.execute("SELECT cf_id FROM daily_completions WHERE date = ?", (today,)).fetchall()}

        enriched = _enrich_songs(meta_db, songs, done_ids)
        map_state = _map_available_state(conn, today, map_data, None if debug_map else install_id) if map_data else None
        is_complete = map_state["is_complete"] if map_state else len(done_ids) >= song_count
        progress_done = len(map_state["cleared_node_ids"]) if map_state else len(done_ids)
        progress_total = len([n for n in map_data.get("nodes", []) if n.get("type") not in ("forced", "boss")]) if map_data else song_count

        day_number = (date.fromisoformat(today) - _EPOCH).days + 1
        has_unavailable = any(not s["has_locally"] for s in enriched)
        mod_label = mod["label"] if mod else modifier_id
        mod_desc = mod["description"] if mod and "description" in mod else ""
        mod_icon = mod.get("icon", "") if mod else ""
        mod_type = mod["type"] if mod and "type" in mod else "filter"
        payload = {
            "date": today,
            "seed": _date_seed(today),
            "day_name": day_name,
            "day_number": day_number,
            "modifier": {
                "id": modifier_id,
                "label": mod_label,
                "description": mod_desc,
                "icon": mod_icon,
                "is_blindside": mod_type == "ui",
            },
            "fallback": fallback,
            "songs": enriched,
            "song_count": song_count,
            "progress": {"done": progress_done, "total": progress_total},
            "is_complete": is_complete,
            "has_unavailable": has_unavailable,
            "map": map_data,
            "used_reroll": used_reroll,
            "inventory": {"items": [BOSS_REROLL_ITEM] * 99, "counts": {BOSS_REROLL_ITEM: 99}} if debug_map else _inventory_payload(conn, install_id),
            "debug_no_save": debug_map,
            "debug_real_today": real_today if debug_map else None,
            "pool_stamp": pool_stamp,
        }
        if map_state:
            payload.update(map_state)

        # Add committed_lane info for today
        if install_id:
            committed_lane = _compute_committed_lane(conn, today, install_id)
            if committed_lane:
                payload["committed_lane"] = committed_lane

        return payload
    # Diagnostic: log that the_daily module has loaded routes
    try:
        print("the_daily: routes registered: /today, /setlist/{date}, /mark, /use-item, /streak, /leaderboard")
    except Exception:
        pass

    @app.get("/api/plugins/the_daily/setlist/{date_str}")
    def get_setlist_by_date(date_str: str):
        # Validate date format
        try:
            target = date.fromisoformat(date_str)
        except Exception:
            return {"error": "Invalid date format"}, 400

        today_date = _get_today()
        if target > today_date:
            return {"error": "Future dates are not allowed"}, 400

        conn = _get_conn()
        plugin_dir = Path(__file__).parent
        # Historical locally-generated setlist (seed-based) when data is not in DB
        def _generate_historical_setlist(target_date_str: str):
            try:
                targ = date.fromisoformat(target_date_str)
            except Exception:
                return None
            try:
                active = _get_active_modifier(target_date_str)
            except RuntimeError:
                return None
            mod_id = _pick_modifier(target_date_str, active)
            mod = next(m for m in active if m["id"] == mod_id)
            pool = _load_pool(target_date_str, plugin_dir)
            if not pool:
                return None

            # Exclude songs used in the last 14 days before the target date
            used_cf = set()
            for i in range(1, 15):
                past = (targ - timedelta(days=i)).isoformat()
                past_row = conn.execute("SELECT songs FROM daily_setlists WHERE date = ?", (past,)).fetchone()
                if past_row:
                    for s in json.loads(past_row[0]):
                        used_cf.add(s.get("cf_id"))

            fresh_pool = [s for s in pool if s.get("cf_id") not in used_cf]
            active_pool = fresh_pool if len(fresh_pool) >= DEFAULT_SONG_COUNT else pool

            exclude = None
            if mod_id == "artist_takeover":
                exclude = set()
                for i in range(1, 15):
                    past = (targ - timedelta(days=i)).isoformat()
                    past_row = conn.execute("SELECT modifier, songs FROM daily_setlists WHERE date = ?", (past,)).fetchone()
                    if past_row and past_row[0] == "artist_takeover":
                        past_songs = json.loads(past_row[1])
                        if past_songs:
                            exclude.add((past_songs[0].get("artist") or "").lower())

            map_data = None
            if targ >= MAP_MODE_START:
                map_data, songs, fallback = _build_map(target_date_str, mod_id, active_pool, active, exclude=exclude)
                song_count = 1
            else:
                songs, song_count, fallback = _select_songs(target_date_str, mod_id, active_pool, active, exclude=exclude)
            day_name = _day_name(target_date_str, mod, songs)

            # Build lane_paths from map_data
            lane_paths = {}
            if map_data and map_data.get("nodes"):
                nodes_by_lane = {}
                for node in map_data.get("nodes", []):
                    lane = node.get("lane")
                    if lane:
                        if lane not in nodes_by_lane:
                            nodes_by_lane[lane] = []
                        nodes_by_lane[lane].append(node["id"])
                lane_paths = nodes_by_lane

            # Enrich songs with local availability
            enriched = []
            for s in (songs or []):
                s2 = dict(s)
                s2["local_filename"] = _find_locally(meta_db, s2)
                s2["has_locally"] = s2["local_filename"] is not None
                enriched.append(s2)
            day_num = (targ - _EPOCH).days + 1
            map_state = _map_available_state(conn, target_date_str, map_data, None) if map_data else None
            is_complete = map_state["is_complete"] if map_state else (len(done_ids or []) >= song_count)
            progress_done = len(map_state["cleared_node_ids"]) if map_state else len(done_ids or [])
            progress_total = len([n for n in map_data.get("nodes", []) if n.get("type") not in ("forced", "boss")]) if map_data else song_count
            return {
                "date": target_date_str,
                "seed": _date_seed(target_date_str),
                "day_name": day_name,
                "day_number": day_num,
                "modifier": {
                    "id": mod_id,
                    "label": mod["label"],
                    "description": mod["description"],
                    "icon": mod.get("icon", ""),
                    "is_blindside": mod["type"] == "ui",
                },
                "fallback": fallback,
                "songs": enriched,
                "song_count": song_count,
                "progress": {"done": progress_done, "total": progress_total},
                "is_complete": is_complete,
                "has_unavailable": any(not s.get("has_locally") for s in enriched),
                "is_historical": True,
                "map": map_data,
                "lane_paths": lane_paths,
            }

        # Helper to build payload from a retrieved row
        def build_payload(row, is_historical: bool, mod_id, songs, song_count, done_ids=None, map_data=None, fallback=False, pool_stamp=None):
            if not row:
                return None
            day_name = row[0]
            modifier_id = mod_id
            if isinstance(modifier_id, tuple):
                modifier_id = modifier_id[0]
            mod = next((m for m in active if m["id"] == modifier_id), {"label": "", "description": "", "icon": "", "type": "filter"})
            enriched = []
            # enrich each song with local_filename, has_locally, done
            for s in (songs or []):
                s2 = dict(s)
                s2["local_filename"] = _find_locally(meta_db, s2)
                s2["has_locally"] = s2["local_filename"] is not None
                s2["done"] = (done_ids or set()).__contains__(s2.get("cf_id"))
                enriched.append(s2)
            day_num = (target - _EPOCH).days + 1
            map_state = _map_available_state(conn, date_str, map_data, None) if map_data else None
            is_complete = map_state["is_complete"] if map_state else (len(done_ids or []) >= song_count)
            progress_done = len(map_state["cleared_node_ids"]) if map_state else len(done_ids or [])
            progress_total = len([n for n in map_data.get("nodes", []) if n.get("type") not in ("forced", "boss")]) if map_data else song_count
            # Get lane_paths from row if available
            lane_paths = None
            if row and len(row) > 5:
                lane_paths_json = row[5] if not is_historical else None
                if lane_paths_json:
                    try:
                        lane_paths = json.loads(lane_paths_json)
                    except Exception:
                        pass
            payload = {
                "date": date_str,
                "seed": _date_seed(date_str),
                "day_name": day_name,
                "day_number": day_num,
                "modifier": {
                    "id": modifier_id,
                    "label": mod["label"],
                    "description": mod["description"],
                    "icon": mod.get("icon", ""),
                    "is_blindside": mod["type"] == "ui",
                },
                "fallback": fallback,
                "songs": enriched,
                "song_count": song_count,
                "progress": {"done": progress_done, "total": progress_total},
                "is_complete": is_complete,
                "has_unavailable": any(not s.get("has_locally") for s in enriched),
                "is_historical": is_historical,
                "map": map_data,
                "lane_paths": lane_paths,
                "pool_stamp": pool_stamp,
            }
            if map_state:
                payload.update(map_state)
            return payload

        # Today
        row = conn.execute(
            "SELECT day_name, modifier, songs, song_count, map, fallback, lane_paths, pool_stamp FROM daily_setlists WHERE date = ?",
            (date_str,),
        ).fetchone()
        if target == today_date:
            if not row:
                return {"error": "No setlist for today"}, 404
            day_name, modifier_id, songs_json, song_count, map_json, fallback_int, lane_paths_json, pool_stamp = row
            songs = json.loads(songs_json)
            map_data = json.loads(map_json) if map_json else None
            # Enrich completion state for today
            done_ids = {r[0] for r in conn.execute("SELECT cf_id FROM daily_completions WHERE date = ?", (date_str,)).fetchall()}
            payload = build_payload(row, False, modifier_id, songs, song_count, done_ids, map_data=map_data, fallback=bool(fallback_int), pool_stamp=pool_stamp)
            return payload

        # Historical
        if row:
            day_name, modifier_id, songs_json, song_count, map_json, fallback_int, lane_paths_json, pool_stamp = row
            songs = json.loads(songs_json)
            map_data = json.loads(map_json) if map_json else None
            done_ids = {r[0] for r in conn.execute("SELECT cf_id FROM daily_completions WHERE date = ?", (date_str,)).fetchall()}
            payload = build_payload(row, True, modifier_id, songs, song_count, done_ids, map_data=map_data, fallback=bool(fallback_int), pool_stamp=pool_stamp)
            return payload
        # Not found for historical date: generate locally if date is historical
        if target < today_date:
            payload = _generate_historical_setlist(date_str)
            if payload:
                return payload
            return {"error": "No setlist for this date yet"}, 404
        # Otherwise, no data for this date
        return {"error": "No setlist for this date yet"}, 404

    MIN_PLAY_DURATION = 30  # seconds required to mark song as complete

    @app.post("/api/plugins/the_daily/mark")
    def mark_song(data: dict):
        cf_id = data.get("cf_id")
        node_id = data.get("node_id")
        install_id = _client_install_id(data=data)
        action = data.get("action")
        debug_no_save = _DEBUG_ENABLED and bool(data.get("debug_no_save"))
        force_complete = bool(data.get("force_complete"))
        duration_played = data.get("duration_played", 0)
        # Debug-only path: force-complete a node without playing.
        # Bypasses cf_id and validation; requires debug_no_save.
        if force_complete and debug_no_save:
            today = _get_today().isoformat()
            if data.get("debug_date"):
                try:
                    today = date.fromisoformat(str(data.get("debug_date"))).isoformat()
                except Exception:
                    pass
            conn = _get_conn()
            pool = _load_pool(today, plugin_dir)
            modifier_id = _pick_modifier(today)
            active_pool = _daily_active_pool(conn, today, pool)
            exclude = _daily_artist_exclude(conn, today, modifier_id)
            map_data, _, _ = _build_map(today, modifier_id, active_pool, exclude=exclude)
            if not map_data or not node_id:
                return {"error": "node_id required"}
            client_cleared = set(data.get("cleared_node_ids") or [])
            client_committed = set(data.get("committed_node_ids") or [])
            client_cleared.add(node_id)
            client_committed.add(node_id)
            state = _debug_map_state(map_data, client_cleared, client_committed)
            return {
                "ok": True,
                "debug_no_save": True,
                "force_complete": True,
                "progress": {"done": len(state["cleared_node_ids"]), "total": len(map_data.get("nodes", []))},
                **state,
                "inventory": {"items": [BOSS_REROLL_ITEM] * 99, "counts": {BOSS_REROLL_ITEM: 99}},
            }
        if not cf_id:
            return {"error": "cf_id required"}
        today = _get_today().isoformat()
        if debug_no_save and data.get("debug_date"):
            try:
                today = date.fromisoformat(str(data.get("debug_date"))).isoformat()
            except Exception:
                today = _get_today().isoformat()
        conn = _get_conn()

        if debug_no_save:
            pool = _load_pool(today, plugin_dir)
            modifier_id = _pick_modifier(today)
            active_pool = _daily_active_pool(conn, today, pool)
            exclude = _daily_artist_exclude(conn, today, modifier_id)
            map_data, songs, _ = _build_map(today, modifier_id, active_pool, exclude=exclude)
            song_count = 1
        else:
            row = conn.execute(
                "SELECT song_count, map, songs FROM daily_setlists WHERE date = ?", (today,)
            ).fetchone()
            if not row:
                return {"error": "No setlist for today"}
            song_count, map_json, songs_json = row
            map_data = json.loads(map_json) if map_json else None
        if map_data:
            if not debug_no_save:
                map_data, songs, used_reroll = _apply_boss_reroll(conn, today, map_data, json.loads(songs_json), install_id)
            nodes = _node_by_id(map_data)
            node = nodes.get(node_id)
            if not node:
                return {"error": "node_id required"}
            if int(cf_id) not in {int(x) for x in _node_song_ids(node) if x is not None}:
                return {"error": "cf_id is not valid for node"}
            state = _map_available_state(conn, today, map_data, None if debug_no_save else install_id)
            if debug_no_save:
                client_cleared = set(data.get("cleared_node_ids") or [])
                client_committed = set(data.get("committed_node_ids") or [])
                state = _debug_map_state(map_data, client_cleared, client_committed)
            if node_id not in state["available_node_ids"] and node_id not in state["committed_node_ids"] and node_id not in state["cleared_node_ids"]:
                return {"error": "Node is not available"}

            if action == "commit":
                if debug_no_save:
                    client_committed = set(data.get("committed_node_ids") or [])
                    client_committed.add(node_id)
                    state = _debug_map_state(map_data, set(data.get("cleared_node_ids") or []), client_committed)
                    return {"ok": True, "committed": True, "debug_no_save": True, "progress": {"done": len(state["cleared_node_ids"]), "total": len(map_data.get("nodes", []))}, **state}
                with _lock:
                    conn.execute(
                        "INSERT OR IGNORE INTO daily_node_commits (install_id, date, node_id, cf_id) VALUES (?, ?, ?, ?)",
                        (install_id or "anonymous", today, node_id, cf_id),
                    )
                    conn.commit()
                state = _map_available_state(conn, today, map_data, install_id)
                return {"ok": True, "committed": True, "progress": {"done": len(state["cleared_node_ids"]), "total": len(map_data.get("nodes", []))}, **state}

        # Check if minimum play duration was met
        if duration_played < MIN_PLAY_DURATION:
            return {
                "ok": False,
                "requires_confirmation": True,
                "duration_played": duration_played,
                "threshold": MIN_PLAY_DURATION,
                "progress": {"done": 0, "total": song_count},
                "is_complete": False,
            }

        if map_data and debug_no_save:
            client_cleared = set(data.get("cleared_node_ids") or [])
            client_committed = set(data.get("committed_node_ids") or [])
            client_cleared.add(node_id)
            client_committed.add(node_id)
            state = _debug_map_state(map_data, client_cleared, client_committed)
            return {
                "ok": True,
                "debug_no_save": True,
                "progress": {"done": len(state["cleared_node_ids"]), "total": len(map_data.get("nodes", []))},
                **state,
                "inventory": {"items": [BOSS_REROLL_ITEM] * 99, "counts": {BOSS_REROLL_ITEM: 99}},
            }

        with _lock:
            if map_data:
                conn.execute(
                    "INSERT OR IGNORE INTO daily_node_commits (install_id, date, node_id, cf_id) VALUES (?, ?, ?, ?)",
                    (install_id or "anonymous", today, node_id, cf_id),
                )
                conn.execute(
                    "INSERT OR IGNORE INTO daily_completions (date, cf_id, node_id, install_id) VALUES (?, ?, ?, ?)",
                    (today, cf_id, node_id, install_id),
                )
            else:
                conn.execute(
                    "INSERT OR IGNORE INTO daily_completions (date, cf_id) VALUES (?, ?)",
                    (today, cf_id),
                )
            conn.commit()

        if map_data:
            state = _map_available_state(conn, today, map_data, install_id)
            if state["is_complete"]:
                _award_inventory_for_completion(conn, install_id, today)
                _mirror_push_debounced(install_id)
            return {
                "ok": True,
                "progress": {"done": len(state["cleared_node_ids"]), "total": len(map_data.get("nodes", []))},
                **state,
                "inventory": _inventory_payload(conn, install_id),
            }

        done = conn.execute("SELECT COUNT(*) FROM daily_completions WHERE date = ?", (today,)).fetchone()[0]

        return {
            "ok": True,
            "progress": {"done": done, "total": song_count},
            "is_complete": done >= song_count,
        }

    @app.post("/api/plugins/the_daily/use-item")
    def use_item(data: dict):
        install_id = _client_install_id(data=data)
        item_id = data.get("item_id")
        debug_no_save = _DEBUG_ENABLED and bool(data.get("debug_no_save"))
        if not install_id:
            return {"error": "install_id required"}
        if item_id not in (BOSS_REROLL_ITEM, LANE_REROLL_ITEM):
            return {"error": "Unknown item"}

        today = _get_today().isoformat()
        if debug_no_save and data.get("debug_date"):
            try:
                today = date.fromisoformat(str(data.get("debug_date"))).isoformat()
            except Exception:
                today = _get_today().isoformat()
        conn = _get_conn()
        if debug_no_save:
            pool = _load_pool(today, plugin_dir)
            modifier_id = _pick_modifier(today)
            active_pool = _daily_active_pool(conn, today, pool)
            exclude = _daily_artist_exclude(conn, today, modifier_id)
            map_data, songs, _ = _build_map(today, modifier_id, active_pool, exclude=exclude)
            state = _debug_map_state(map_data, set(data.get("cleared_node_ids") or []), set(data.get("committed_node_ids") or []))
        else:
            row = conn.execute(
                "SELECT modifier, songs, map FROM daily_setlists WHERE date = ?", (today,)
            ).fetchone()
            if not row:
                return {"error": "No setlist for today"}
            modifier_id, songs_json, map_json = row
            if not map_json:
                return {"error": "Items are only available in Map Mode"}
            map_data = json.loads(map_json)
            state = _map_available_state(conn, today, map_data, install_id)
        # Boss Re-roll
        if item_id == BOSS_REROLL_ITEM:
            if state["boss_revealed"]:
                return {"error": "Boss already revealed"}
            if not debug_no_save and conn.execute(
                "SELECT 1 FROM daily_boss_rerolls WHERE install_id = ? AND date = ?",
                (install_id, today),
            ).fetchone():
                return {"error": "Boss already re-rolled today"}
            
            inv = {"items": [BOSS_REROLL_ITEM], "counts": {BOSS_REROLL_ITEM: 1}} if debug_no_save else _inventory_payload(conn, install_id)
            items = list(inv["items"])
            if BOSS_REROLL_ITEM not in items:
                return {"error": "No Boss Re-roll available"}

            boss_node = _node_by_id(map_data).get(map_data.get("boss"))
            pool = _load_pool(today, plugin_dir)
            active_pool = _daily_active_pool(conn, today, pool)
            modifier_pool, _ = _map_modifier_pool(
                today, modifier_id, active_pool,
                exclude=_daily_artist_exclude(conn, today, modifier_id),
            )
            map_song_ids = {cf_id for node in map_data.get("nodes", []) for cf_id in _node_song_ids(node)}
            eligible = [s for s in modifier_pool if _boss_eligible(s) and s.get("cf_id") not in map_song_ids]
            if not eligible:
                return {"error": "No alternative boss available"}
            rng = random.Random(_date_seed(today) + install_id + "bossreroll")
            rerolled = rng.choice(sorted(eligible, key=lambda s: int(s.get("cf_id") or 0)))
            
            if debug_no_save:
                return {
                    "ok": True,
                    "debug_no_save": True,
                    "boss_cf_id": rerolled["cf_id"],
                    "song": rerolled,
                    "inventory": {"items": [BOSS_REROLL_ITEM] * 99, "counts": {BOSS_REROLL_ITEM: 99}},
                }
            items.remove(BOSS_REROLL_ITEM)
            with _lock:
                conn.execute(
                    "INSERT INTO daily_boss_rerolls (install_id, date, rerolled_cf_id) VALUES (?, ?, ?)",
                    (install_id, today, rerolled["cf_id"]),
                )
                conn.execute(
                    "UPDATE daily_inventory SET items = ?, updated_at = datetime('now') WHERE install_id = ?",
                    (json.dumps(items), install_id),
                )
                conn.commit()
            return {"ok": True, "boss_cf_id": rerolled["cf_id"], "song": rerolled, "inventory": _inventory_payload(conn, install_id)}
        
        # Lane Re-roll
        if item_id == LANE_REROLL_ITEM:
            node_id = data.get("node_id")
            print(f"DEBUG: Lane reroll called for node: {node_id}", file=sys.stderr)
            if not node_id:
                print("DEBUG: node_id missing", file=sys.stderr)
                return {"error": "node_id required"}
            inv = {"items": [LANE_REROLL_ITEM], "counts": {LANE_REROLL_ITEM: 1}} if debug_no_save else _inventory_payload(conn, install_id)
            items = list(inv["items"])
            print(f"DEBUG: Inventory: {items}", file=sys.stderr)
            if not debug_no_save and LANE_REROLL_ITEM not in items:
                print("DEBUG: Lane reroll not in inventory", file=sys.stderr)
                return {"error": "No Lane Re-roll available"}
            
            if debug_no_save:
                return {
                    "ok": True,
                    "debug_no_save": True,
                    "node_id": node_id,
                    "effect": {"rerolled": True},
                    "inventory": {"items": [LANE_REROLL_ITEM] * 99, "counts": {LANE_REROLL_ITEM: 99}},
                }
            items.remove(LANE_REROLL_ITEM)



    @app.get("/api/plugins/the_daily/streak")
    def get_streak():
        conn = _get_conn()
        today_str = _get_today().isoformat()
        streak = _compute_streak(conn, today_str)
        install_id = _client_install_id(request=None, data={})
        committed_lane_today = _compute_committed_lane(conn, today_str, install_id)
        lane_streaks = {}
        for lane in ["sprint", "marathon", "drop", "flat"]:
            ls = _compute_lane_streak(conn, today_str, lane)
            if ls > 0:
                lane_streaks[lane] = ls
        return {
            "streak": streak,
            "lane_streaks": lane_streaks,
            "committed_lane_today": committed_lane_today,
        }

    @app.get("/api/plugins/the_daily/stats")
    def get_stats():
        conn = _get_conn()
        today = _get_today().isoformat()

        # Total songs played (all time)
        total_played = conn.execute("SELECT COUNT(*) FROM daily_completions").fetchone()[0] or 0

        # Total unique days completed
        total_days_completed = conn.execute("SELECT COUNT(*) FROM daily_setlists").fetchone()[0] or 0

        # Current streak
        streak = _compute_streak(conn, today)

        # Songs played today
        played_today = conn.execute(
            "SELECT COUNT(*) FROM daily_completions WHERE date = ?", (today,)
        ).fetchone()[0] or 0

        return {
            "total_played": total_played,
            "streak": streak,
            "played_today": played_today,
            "total_days": total_days_completed,
        }

    @app.get("/api/plugins/the_daily/health")
    def get_health():
        # Expose registered endpoints for quick diagnosis in the host environment
        endpoints = []
        for r in app.router.routes:
            path = getattr(r, 'path', None)
            if path and isinstance(path, str) and path.startswith('/api/plugins/the_daily/'):
                endpoints.append(path)
        # Additional health signals
        today_path = "/api/plugins/the_daily/today" in endpoints
        setlist_by_date_path = any(p.startswith("/api/plugins/the_daily/setlist/") for p in endpoints)
        conn = _get_conn()
        pool_count = conn.execute("SELECT COUNT(*) FROM pool_cache").fetchone()[0]
        today = _get_today().isoformat()
        today_has_row = conn.execute("SELECT 1 FROM daily_setlists WHERE date = ?", (today,)).fetchone() is not None
        return {
            "registered_endpoints": endpoints,
            "today_registered": today_path,
            "setlist_by_date_registered": setlist_by_date_path,
            "pool_cache_rows": pool_count,
            "today_has_row": today_has_row,
        }

    @app.get("/api/plugins/the_daily/health_diag")
    def health_diag():
        conn = _get_conn()
        endpoints = []
        for r in app.router.routes:
            path = getattr(r, 'path', None)
            if path and isinstance(path, str) and path.startswith('/api/plugins/the_daily/'):
                endpoints.append(path)
        today_path = "/api/plugins/the_daily/today" in endpoints
        setlist_by_date_path = any(p.startswith("/api/plugins/the_daily/setlist/") for p in endpoints)
        pool_count = conn.execute("SELECT COUNT(*) FROM pool_cache").fetchone()[0]
        today = _get_today().isoformat()
        today_has_row = conn.execute("SELECT 1 FROM daily_setlists WHERE date = ?", (today,)).fetchone() is not None
        return {
            "endpoints": endpoints,
            "today_registered": today_path,
            "setlist_by_date_registered": setlist_by_date_path,
            "pool_cache_rows": pool_count,
            "today_has_row": today_has_row,
        }

    @app.get("/api/plugins/the_daily/test")
    def test_endpoint():
        return {"ok": True}

    @app.get("/api/plugins/the_daily/leaderboard")
    def get_leaderboard(date: str = None, lane: str = None):
        # Normalize target date and enforce Day 1 boundaries
        import datetime as _dt
        from datetime import date as _Date
        today_dt = _get_today()
        today = today_dt
        if date:
            try:
                target = _Date.fromisoformat(date)
            except Exception:
                target = today
        else:
            target = today

        day1 = _EPOCH

        # If target is before Day 1, clamp to Day 1 if data exists, else no data
        if target < day1:
            exists_day1 = _get_conn().execute(
                "SELECT 1 FROM daily_setlists WHERE date = ?", (day1.isoformat(),)
            ).fetchone()
            if exists_day1:
                target = day1
            else:
                return {
                    "date": day1.isoformat(),
                    "available": False,
                    "entries": [],
                    "total_entries": 0,
                    "last_updated": None,
                }

        # Future date not available
        if target > today:
            return {
                "date": target.isoformat(),
                "available": False,
                "entries": [],
                "total_entries": 0,
                "last_updated": None,
            }

        # Per-day cache lookup
        cache_key = target.isoformat()
        cached = _lb_cache.get(cache_key)
        if cached:
            expiry, payload = cached
            if expiry is None or expiry > int(_time.time()):
                return payload

        conn = _get_conn()
        try:
            active = _get_active_modifier(target.isoformat())
        except RuntimeError:
            active = []
        row = conn.execute(
            "SELECT day_name, modifier FROM daily_setlists WHERE date = ?", (target.isoformat(),)
        ).fetchone()

        # Compute the day number without relying on date.fromisoformat to avoid name shadowing issues
        day_num = (target - _EPOCH).days + 1
        day_name = row[0] if row else f"Daily #{day_num}"
        modifier_id = row[1] if row and len(row) > 1 else None
        seed = _date_seed(target.isoformat()) if target else None
        fallback = False

        if active:
            mod = next((m for m in active if m["id"] == modifier_id), {"label": "", "description": "", "icon": "", "type": "filter"}) if modifier_id else {}
        else:
            mod = {"label": "", "description": "", "icon": "", "type": "filter"} if modifier_id else {}
        modifier = {
            "id": modifier_id,
            "label": mod.get("label", ""),
            "description": mod.get("description", ""),
            "icon": mod.get("icon", ""),
            "is_blindside": mod.get("type") == "ui",
        } if modifier_id else {}

        if not SUPABASE_URL or SUPABASE_URL.startswith("https://YOURPROJECT"):
            payload = {
                "date": target.isoformat(),
                "day_name": day_name,
                "day_number": day_num,
                "seed": seed,
                "modifier": modifier,
                "fallback": fallback,
                "entries": [],
                "lane_popularity": [],
                "available": True,
                "total_entries": 0,
                "last_updated": None,
            }
            _lb_cache[cache_key] = (int(_time.time()) + LB_CACHE_TTL, payload)
            return payload

        try:
            params = {
                "date": f"eq.{target.isoformat()}",
                "order": "completed_at.asc",
                "select": "*",
            }
            if lane:
                params["lane"] = f"eq.{lane}"
            entries = _supabase_get(
                "/rest/v1/leaderboard",
                params,
            )
        except Exception as e:
            payload = {"date": target.isoformat(), "day_name": day_name, "entries": [], "available": True, "total_entries": 0, "last_updated": None}
            _lb_cache[cache_key] = (int(_time.time()) + LB_CACHE_TTL, payload)
            return payload

        last_updated = None
        if isinstance(entries, list) and entries:
            times = [e.get("completed_at") for e in entries if e.get("completed_at")]
            if times:
                last_updated = max(times)

        payload = {
            "date": target.isoformat(),
            "day_name": day_name,
            "day_number": day_num,
            "seed": seed,
            "modifier": modifier,
            "fallback": fallback,
            "entries": entries or [],
            "lane_popularity": _lane_popularity(entries or []),
            "available": True,
            "total_entries": len(entries or []),
            "last_updated": last_updated,
        }
        _lb_cache[cache_key] = (int(_time.time()) + LB_CACHE_TTL, payload)
        return payload

    @app.get("/api/plugins/the_daily/inventory")
    def get_inventory(request: Request):
        install_id = _client_install_id(request=request)
        if not install_id:
            return {"error": "install_id required"}
        conn = _get_conn()
        inv = _inventory_payload(conn, install_id)
        # Also check and award any new stamps
        new_stamps = _check_stamps(conn, install_id)
        stamps = [r[0] for r in conn.execute(
            "SELECT stamp_id FROM daily_stamps WHERE install_id = ? ORDER BY earned_date",
            (install_id,)
        ).fetchall()]
        inv["stamps"] = stamps
        inv["new_stamps"] = new_stamps
        return inv

    @app.get("/api/plugins/the_daily/recovery-code")
    def get_recovery_code(request: Request):
        install_id = _client_install_id(request=request)
        if not install_id:
            return {"error": "install_id required"}
        conn = _get_conn()
        code = _get_or_create_recovery_code(conn, install_id)
        return {"code": code}

    @app.post("/api/plugins/the_daily/recovery-code/adopt")
    async def adopt_recovery_code(request: Request):
        install_id = _client_install_id(request=request)
        if not install_id:
            return {"error": "install_id required"}
        try:
            body = await request.json()
        except Exception:
            body = {}
        new_code = (body.get("code") or "").strip().lower()
        if not _is_valid_code_shape(new_code):
            return {"error": "Invalid code format"}
        conn = _get_conn()
        # Attempt pull from Supabase before overwriting local
        remote = _mirror_pull(new_code)
        if remote:
            with _lock:
                conn.execute(
                    "INSERT INTO daily_inventory (install_id, recovery_code, tokens, cosmetics, equipped) VALUES (?, ?, ?, ?, ?) "
                    "ON CONFLICT(install_id) DO UPDATE SET "
                    "recovery_code = excluded.recovery_code, "
                    "tokens = excluded.tokens, "
                    "cosmetics = excluded.cosmetics, "
                    "equipped = excluded.equipped",
                    (
                        install_id, new_code,
                        remote.get("tokens", 0),
                        json.dumps(remote.get("cosmetics", [])),
                        json.dumps(remote.get("equipped", {})),
                    ),
                )
                # Replace stamps too
                conn.execute("DELETE FROM daily_stamps WHERE install_id = ?", (install_id,))
                for sid in remote.get("stamps", []):
                    conn.execute(
                        "INSERT INTO daily_stamps (install_id, stamp_id, earned_date) VALUES (?, ?, ?)",
                        (install_id, sid, _get_today().isoformat())
                    )
                conn.commit()
            return {"code": new_code, "adopted": True, "restored": True}
        # No remote row, just adopt the code locally
        with _lock:
            conn.execute(
                "INSERT INTO daily_inventory (install_id, recovery_code) VALUES (?, ?) "
                "ON CONFLICT(install_id) DO UPDATE SET recovery_code = excluded.recovery_code",
                (install_id, new_code)
            )
            conn.commit()
        return {"code": new_code, "adopted": True}

    @app.post("/api/plugins/the_daily/sync-now")
    async def sync_now(request: Request):
        install_id = _client_install_id(request=request)
        if not install_id:
            return {"error": "install_id required"}
        ok = _mirror_push(install_id)  # synchronous, not debounced
        return {"ok": ok}

    @app.get("/api/plugins/the_daily/shop")
    def get_shop(request: Request, node_id: str | None = None):
        install_id = _client_install_id(request=request)
        conn = _get_conn()
        inv = _inventory_payload(conn, install_id) if install_id else {"tokens": 0, "cosmetics": [], "equipped": {}}
        tokens = inv["tokens"]
        owned = set(inv["cosmetics"])
        equipped = inv.get("equipped", {})
        equipped_ids = set(equipped.values()) if equipped else set()

        items = []
        for cid, c in COSMETICS.items():
            items.append({
                "id": cid, "name": c["name"], "type": c["type"], "cost": c["cost"],
                "slot": c.get("type"),
                "description": c.get("description", ""),
                "is_cosmetic": True,
                "owned": cid in owned,
                "equipped": cid in equipped_ids,
                "affordable": tokens >= c["cost"],
                "purchased_at": next((x["purchased_at"] for x in inv.get("cosmetics", []) if x["id"] == cid), None),
            })
        for cid, c in CONSUMABLES.items():
            items.append({
                "id": cid, "name": c["name"], "type": "consumable",
                "description": c["description"], "cost": c["cost"],
                "is_cosmetic": False,
                "owned": False,
                "affordable": tokens >= c["cost"],
            })

        discount = None
        if node_id:
            offer = _shop_offer_for_node(datetime.utcnow().date().isoformat(), node_id)
            for it in items:
                if it["id"] in offer:
                    it["discounted_cost"] = round(it["cost"] * 0.9)
                    it["affordable"] = tokens >= it["discounted_cost"]
            discount = {"node_id": node_id, "items": list(offer), "rate": 0.1}

        return {"tokens": tokens, "items": items, "discount": discount}

    @app.post("/api/plugins/the_daily/shop/buy")
    async def buy_item(request: Request):
        body = await request.json()
        item_id = body.get("item_id")
        node_id = body.get("node_id")  # optional — set when bought from map shop node
        install_id = _client_install_id(request=request, data=body)
        if not install_id:
            return {"error": "install_id required"}

        cosmetic = COSMETICS.get(item_id)
        consumable = CONSUMABLES.get(item_id)
        if not cosmetic and not consumable:
            return {"error": "Unknown item"}

        base_cost = (cosmetic or consumable)["cost"]
        cost = base_cost
        if node_id:
            offer = _shop_offer_for_node(datetime.utcnow().date().isoformat(), node_id)
            if item_id in offer:
                cost = round(base_cost * 0.9)

        conn = _get_conn()
        with _lock:
            inv = conn.execute(
                "SELECT tokens, cosmetics FROM daily_inventory WHERE install_id = ?",
                (install_id,)
            ).fetchone()
            tokens = inv[0] if inv else 0
            owned = set(json.loads(inv[1])) if inv and inv[1] else set()

            if cosmetic and item_id in owned:
                return {"error": "Already owned"}
            if tokens < cost:
                return {"error": "Insufficient tokens"}

            new_tokens = tokens - cost
            if cosmetic:
                owned.add(item_id)
                cosmetics_blob = json.dumps(sorted(owned))
                conn.execute("""
                    INSERT INTO daily_inventory (install_id, tokens, cosmetics) VALUES (?, ?, ?)
                    ON CONFLICT(install_id) DO UPDATE SET tokens = ?, cosmetics = ?
                """, (install_id, new_tokens, cosmetics_blob, new_tokens, cosmetics_blob))
                _record_purchase_time(install_id, item_id)
                result = {"item_id": item_id, "new_balance": new_tokens, "owned": True}
            else:  # consumable — execute on buy
                conn.execute(
                    "UPDATE daily_inventory SET tokens = ? WHERE install_id = ?",
                    (new_tokens, install_id)
                )
                effect = _execute_consumable(item_id, install_id)
                result = {"item_id": item_id, "new_balance": new_tokens, "effect": effect}

            conn.execute(
                "INSERT INTO daily_token_ledger (install_id, date, delta, reason) VALUES (?, ?, ?, ?)",
                (install_id, datetime.utcnow().date().isoformat(), -cost, f"shop:{item_id}")
            )
            conn.commit()

        if "_mirror_push_debounced" in globals():
            _mirror_push_debounced(install_id)

        return result

    @app.post("/api/plugins/the_daily/shop/refund")
    async def refund_item(request: Request):
        body = await request.json()
        item_id = body.get("item_id")
        install_id = _client_install_id(request=request)
        cosmetic = COSMETICS.get(item_id)
        if not cosmetic:
            return {"error": "Refunds only apply to cosmetics"}
        purchased_at = _get_purchase_time(install_id, item_id)
        if not purchased_at:
            return {"error": "Item not owned"}
        seconds_since = (datetime.utcnow() - purchased_at).total_seconds()
        if seconds_since > 60:
            return {"error": "Refund window expired"}
        conn = _get_conn()
        with _lock:
            inv = conn.execute(
                "SELECT tokens, cosmetics FROM daily_inventory WHERE install_id = ?",
                (install_id,)
            ).fetchone()
            if not inv:
                return {"error": "Inventory not found"}
            tokens = inv[0]
            owned = set(json.loads(inv[1]) if inv[1] else [])
            if item_id not in owned:
                return {"error": "Item not owned"}
            owned.discard(item_id)
            new_tokens = tokens + cosmetic["cost"]
            conn.execute("""
                INSERT INTO daily_inventory (install_id, tokens, cosmetics) VALUES (?, ?, ?)
                ON CONFLICT(install_id) DO UPDATE SET tokens = ?, cosmetics = ?
            """, (install_id, new_tokens, json.dumps(sorted(owned)), new_tokens, json.dumps(sorted(owned))))
            conn.execute(
                "INSERT INTO daily_token_ledger (install_id, date, delta, reason) VALUES (?, ?, ?, ?)",
                (install_id, datetime.utcnow().date().isoformat(), cosmetic["cost"], f"refund:{item_id}")
            )
            conn.execute(
                "DELETE FROM daily_purchases WHERE install_id = ? AND item_id = ?",
                (install_id, item_id)
            )
            conn.commit()
        if "_mirror_push_debounced" in globals():
            _mirror_push_debounced(install_id)
        return {"refunded": True}

    @app.post("/api/plugins/the_daily/equip")
    async def equip_cosmetic(request: Request):
        body = await request.json()
        slot = body.get("slot")  # "flair", "map_theme", "lane_skin", "calendar_art"
        cosmetic_id = body.get("cosmetic_id")  # null = unequip
        install_id = _client_install_id(request=request)
        if not install_id:
            return {"error": "install_id required"}
        if not slot:
            return {"error": "slot required"}

        conn = _get_conn()
        inv = _inventory_payload(conn, install_id)
        equipped = dict(inv["equipped"])

        if cosmetic_id is None:
            equipped.pop(slot, None)
        else:
            c = COSMETICS.get(cosmetic_id)
            if not c or c["type"] != slot:
                return {"error": "Cosmetic does not match slot"}
            if cosmetic_id not in inv["cosmetics"]:
                return {"error": "Not owned"}
            equipped[slot] = cosmetic_id

        with _lock:
            conn.execute(
                "UPDATE daily_inventory SET equipped = ? WHERE install_id = ?",
                (json.dumps(equipped), install_id)
            )
            conn.commit()

        if "_mirror_push_debounced" in globals():
            _mirror_push_debounced(install_id)
        return {"equipped": equipped}

    @app.get("/api/plugins/the_daily/passport")
    def get_passport(request: Request):
        install_id = _client_install_id(request=request)
        if not install_id:
            return {"error": "install_id required"}

        conn = _get_conn()
        today_str = _get_today().isoformat()

        # All daily_setlists rows up to today, with completion info for this install
        rows = conn.execute("""
            SELECT
                ds.date,
                ds.day_name,
                ds.modifier,
                dc.committed_lane,
                COUNT(dcomp.cf_id)        AS done_count,
                ds.song_count
            FROM daily_setlists ds
            LEFT JOIN daily_completions dc ON dc.date = ds.date AND dc.install_id = ?
            LEFT JOIN daily_completions dcomp ON dcomp.date = ds.date AND dcomp.install_id = ?
            WHERE ds.date <= ?
            GROUP BY ds.date
            ORDER BY ds.date ASC
        """, (install_id, install_id, today_str)).fetchall()

        days = []
        for r in rows:
            d, day_name, modifier, lane, done, total = r
            days.append({
                "date": d,
                "day_name": day_name,
                "modifier": modifier,
                "lane": lane,
                "boss_done": done >= total if total else False,
                "full_clear": False,
                "streak_at": None,
            })

        # Compute streak_at for each day
        streak = 0
        for d in days:
            if d["boss_done"]:
                streak += 1
            else:
                streak = 0
            d["streak_at"] = streak

        # Stamps earned by this install
        stamp_rows = conn.execute(
            "SELECT stamp_id, earned_date FROM daily_stamps WHERE install_id = ? ORDER BY earned_date ASC",
            (install_id,)
        ).fetchall()
        stamps_earned = [{"id": s[0], "earned_date": s[1]} for s in stamp_rows]

        # Lifetime totals
        totals = {
            "total_dailies": sum(1 for d in days if d["boss_done"]),
            "longest_streak": max((d["streak_at"] for d in days), default=0),
            "current_streak": days[-1]["streak_at"] if days else 0,
            "lifetime_tokens_earned": conn.execute(
                "SELECT COALESCE(SUM(delta), 0) FROM daily_token_ledger WHERE install_id = ? AND delta > 0",
                (install_id,)
            ).fetchone()[0],
        }

        return {
            "days": days,
            "stamps_earned": stamps_earned,
            "stamps_progress": [],
            "totals": totals,
        }

    @app.post("/api/plugins/the_daily/sign")
    async def sign_leaderboard(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        data = body if isinstance(body, dict) else {}

        # Guard against signing historical days if a date is provided
        if isinstance(data, dict) and data.get("date"):
            try:
                provided = date.fromisoformat(str(data.get("date")))
            except Exception:
                provided = None
            if provided is not None:
                today = _get_today()
                if provided < today:
                    return {"error": "Historical days cannot be signed"}, 403
        display_name = (data.get("display_name") or "").strip()
        valid, err = _validate_display_name(display_name)
        if not valid:
            return {"error": err}
        rating = data.get("rating")
        if rating not in (-1, 1, 2):
            rating = None
        
        message = data.get("message")
        if isinstance(message, str):
            message = message.strip()[:60]
            if not message:
                message = None

        if not SUPABASE_URL or SUPABASE_URL.startswith("https://YOURPROJECT"):
            return {"error": "Supabase not configured"}

        today = _get_today()
        today_str = today.isoformat()
        conn = _get_conn()

        row = conn.execute(
            "SELECT song_count, map FROM daily_setlists WHERE date = ?", (today_str,)
        ).fetchone()
        if not row:
            return {"error": "No setlist for today"}

        map_data = json.loads(row[1]) if row[1] else None
        if not _is_day_complete(conn, today_str):
            return {"error": "Setlist not complete yet"}

        client_ip = _get_client_ip(request)
        if not _check_ip_rate_limit(client_ip, today):
            return {"error": "Too many submissions from this IP today"}

        streak = _compute_streak_from_supabase(client_ip, today) + 1
        day_name = conn.execute(
            "SELECT day_name FROM daily_setlists WHERE date = ?", (today_str,)
        ).fetchone()[0]

        body = {
            "date": today_str,
            "day_name": day_name,
            "display_name": display_name,
            "completed_at": datetime.utcnow().isoformat() + "Z",
            "streak": streak,
            "ip": client_ip,
        }
        install_id = _client_install_id(data=data)
        if map_data:
            cleared = _map_cleared_node_ids(conn, today_str)
            nodes = _node_by_id(map_data)
            path = [n["id"] for n in sorted(map_data.get("nodes", []), key=lambda x: (x.get("row", 0), x.get("col", 0))) if n.get("id") in cleared]
            lanes = [nodes[n].get("lane") for n in path if nodes.get(n) and nodes[n].get("lane")]
            body["path"] = path
            if lanes:
                body["lane_taken"] = lanes[0]
            body["used_reroll"] = bool(install_id and conn.execute(
                "SELECT 1 FROM daily_boss_rerolls WHERE install_id = ? AND date = ?",
                (install_id, today_str),
            ).fetchone())

            # Compute committed_lane and lane_streak
            committed_lane = _compute_committed_lane(conn, today_str, install_id)
            if committed_lane and committed_lane != "mixed":
                body["committed_lane"] = committed_lane
                lane_streak = _compute_lane_streak(conn, today_str, committed_lane)
                body["lane_streak"] = lane_streak + 1  # include today
                # Update daily_completions with committed_lane
                with _lock:
                    conn.execute(
                        "UPDATE daily_completions SET committed_lane = ? WHERE date = ? AND install_id = ?",
                        (committed_lane, today_str, install_id or "anonymous"),
                    )
                    conn.commit()
            elif committed_lane == "mixed":
                body["committed_lane"] = "mixed"
                with _lock:
                    conn.execute(
                        "UPDATE daily_completions SET committed_lane = ? WHERE date = ? AND install_id = ?",
                        ("mixed", today_str, install_id or "anonymous"),
                    )
                    conn.commit()
        if rating is not None:
            body["rating"] = rating
        if message is not None:
            body["message"] = message
        try:
            _supabase_post("/rest/v1/leaderboard", body)
        except Exception as e:
            if any(k in body for k in ("path", "lane_taken", "used_reroll")):
                legacy_body = {k: v for k, v in body.items() if k not in ("path", "lane_taken", "used_reroll")}
                try:
                    _supabase_post("/rest/v1/leaderboard", legacy_body)
                    return {"ok": True, "streak": streak}
                except Exception as e2:
                    e = e2
            err_text = ""
            if hasattr(e, "read"):
                try:
                    err_text = e.read().decode("utf-8", errors="replace")
                except Exception:
                    pass
            err_text = err_text or str(e)
            if "inappropriate" in err_text.lower():
                return {"error": "Name contains inappropriate language"}
            return {"error": f"Could not sign leaderboard: {err_text}"}

        return {"ok": True, "streak": streak}


    # ── Treasure: Foresight peek ────────────────────────────────────
    PEEK_TYPES = ["tomorrow_modifier", "tomorrow_lanes", "boss_song", "mystery_event", "next_two_days", "pool_glimpse"]
    PEEK_LABELS = {
        "tomorrow_modifier": "Tomorrow's Modifier",
        "tomorrow_lanes": "Tomorrow's Lanes",
        "boss_song": "Today's Boss Song",
        "mystery_event": "Mystery Event Hint",
        "next_two_days": "Next Two Days",
        "pool_glimpse": "Pool Glimpse",
    }

    def _lane_label_py(lane_id):
        labels = {"standard": "Standard", "drop": "Drop", "flat": "Flat", "sprint": "Sprint", "marathon": "Marathon", "daily": "Daily"}
        if not lane_id:
            return ""
        if lane_id.startswith("decade_"):
            return lane_id.replace("decade_", "")
        return labels.get(lane_id, lane_id.replace("_", " "))

    def _deterministic_peek_options(date_str, node_id, install_id):
        """Return 3 deterministic peek options for a treasure node."""
        rng = random.Random(_date_seed(date_str) + str(node_id) + str(install_id))
        k = min(3, len(PEEK_TYPES))
        options = rng.sample(PEEK_TYPES, k)
        return sorted(options)

    def _resolve_peek(date_str, node_id, peek_type, install_id, plugin_dir):
        """Resolve the payload for a given peek type."""
        conn = _get_conn()
        today = _get_today().isoformat()

        if peek_type == "tomorrow_modifier":
            tomorrow = (date.fromisoformat(date_str) + timedelta(days=1)).isoformat()
            data = _get_or_generate_setlist(conn, tomorrow, plugin_dir)
            if not data:
                return None, "Could not generate tomorrow's setlist"
            try:
                active = _get_active_modifier(tomorrow)
            except RuntimeError:
                active = []
            mod = next((m for m in active if m["id"] == data["modifier_id"]), {}) if active else {}
            return {
                "type": "tomorrow_modifier",
                "modifier_id": data["modifier_id"],
                "modifier_label": mod.get("label", ""),
                "modifier_icon": mod.get("icon", ""),
                "day_name": data["day_name"],
            }, None

        if peek_type == "tomorrow_lanes":
            tomorrow = (date.fromisoformat(date_str) + timedelta(days=1)).isoformat()
            data = _get_or_generate_setlist(conn, tomorrow, plugin_dir)
            if not data or not data["map"]:
                return None, "Tomorrow's map not available"
            lanes = data["map"].get("lanes", {})
            lane_labels = {k: _lane_label_py(k) for k in lanes if k != "act_labels"}
            return {
                "type": "tomorrow_lanes",
                "lanes": lane_labels,
            }, None

        if peek_type == "boss_song":
            if date_str != today:
                return None, "Boss peek only available for today"
            data = _get_or_generate_setlist(conn, today, plugin_dir)
            if not data or not data["map"]:
                return None, "No map available"
            boss_id = data["map"].get("boss")
            nodes = _node_by_id(data["map"])
            boss_node = nodes.get(boss_id)
            if not boss_node:
                return None, "Boss node not found"
            song_map = {s.get("cf_id"): s for s in data["songs"] if s.get("cf_id")}
            song = song_map.get(boss_node.get("cf_id"))
            if not song:
                return None, "Boss song not found"
            return {
                "type": "boss_song",
                "song": {
                    "title": song.get("title", ""),
                    "artist": song.get("artist", ""),
                    "tuning": song.get("tuning", ""),
                },
            }, None

        if peek_type == "next_two_days":
            results = []
            for delta in (1, 2):
                target = (date.fromisoformat(date_str) + timedelta(days=delta)).isoformat()
                data = _get_or_generate_setlist(conn, target, plugin_dir)
                if data:
                    results.append({
                        "date": target,
                        "modifier_id": data["modifier_id"],
                        "day_name": data["day_name"],
                    })
            return {"type": "next_two_days", "days": results}, None

        if peek_type == "pool_glimpse":
            tomorrow = (date.fromisoformat(date_str) + timedelta(days=1)).isoformat()
            pool = _load_pool(tomorrow, plugin_dir)
            if not pool:
                return None, "Pool not available"
            rng = random.Random(_date_seed(tomorrow) + "pool_glimpse")
            k = min(5, len(pool))
            sample = rng.sample(pool, k)
            return {
                "type": "pool_glimpse",
                "songs": [{"title": s.get("title", ""), "artist": s.get("artist", "")} for s in sample],
            }, None

        if peek_type == "mystery_event":
            return {"type": "mystery_event", "hint": "This node hides a special event. Prepare accordingly."}, None

        return None, "Unknown peek type"


    @app.get("/api/plugins/the_daily/treasure/{node_id}")
    def get_treasure(node_id: str, request: Request):
        install_id = _client_install_id(request=request)
        if not install_id:
            return {"error": "install_id required"}, 400
        today = _get_today().isoformat()
        conn = _get_conn()

        options = _deterministic_peek_options(today, node_id, install_id)
        chosen = conn.execute(
            "SELECT action, payload FROM daily_node_actions WHERE install_id = ? AND date = ? AND node_id = ? AND action LIKE 'peek:%'",
            (install_id, today, node_id),
        ).fetchone()

        result = {
            "node_id": node_id,
            "options": [{"type": t, "label": PEEK_LABELS.get(t, t), "chosen": chosen is not None and chosen[0] == "peek:{}".format(t)} for t in options],
            "chosen": chosen[0].replace("peek:", "") if chosen else None,
            "payload": json.loads(chosen[1]) if chosen and chosen[1] else None,
        }
        return result


    @app.post("/api/plugins/the_daily/treasure/{node_id}")
    async def post_treasure(node_id: str, request: Request):
        install_id = _client_install_id(request=request)
        if not install_id:
            return {"error": "install_id required"}, 400
        try:
            body = await request.json()
        except Exception:
            body = {}
        peek_type = body.get("peek_type")
        if peek_type not in PEEK_TYPES:
            return {"error": "Invalid peek_type"}, 400

        today = _get_today().isoformat()
        conn = _get_conn()

        existing = conn.execute(
            "SELECT action FROM daily_node_actions WHERE install_id = ? AND date = ? AND node_id = ? AND action LIKE 'peek:%'",
            (install_id, today, node_id),
        ).fetchone()
        if existing and existing[0] != "peek:{}".format(peek_type):
            return {"error": "Already chose a different peek for this node"}, 409

        if not existing:
            payload, err = _resolve_peek(today, node_id, peek_type, install_id, plugin_dir)
            if err:
                return {"error": err}, 400
            with _lock:
                conn.execute(
                    "INSERT OR IGNORE INTO daily_node_actions (install_id, date, node_id, action, payload) VALUES (?, ?, ?, ?, ?)",
                    (install_id, today, node_id, "peek:{}".format(peek_type), json.dumps(payload)),
                )
                conn.commit()
        else:
            payload = json.loads(existing[1]) if existing[1] else None

        return {"ok": True, "peek_type": peek_type, "payload": payload}


    # ── Rest: Liner Notes & Bank Progress ────────────────────────────────
    @app.get("/api/plugins/the_daily/rest/{node_id}")
    def get_rest(node_id: str, request: Request, tab: str = "liner"):
        install_id = _client_install_id(request=request)
        today = _get_today().isoformat()
        conn = _get_conn()

        if tab == "liner":
            row = conn.execute(
                "SELECT modifier, songs, map FROM daily_setlists WHERE date = ?", (today,)
            ).fetchone()
            if not row:
                return {"error": "No setlist for today"}, 404
            modifier_id, songs_json, map_json = row
            songs = json.loads(songs_json)
            map_data = json.loads(map_json) if map_json else None

            cleared_ids = {r[0] for r in conn.execute(
                "SELECT cf_id FROM daily_completions WHERE date = ?", (today,)
            ).fetchall()}
            target_song = None
            if map_data:
                nodes = _node_by_id(map_data)
                cleared_nodes = [n for n in map_data.get("nodes", []) if n.get("id") in cleared_ids]
                if cleared_nodes:
                    last_node = sorted(cleared_nodes, key=lambda n: n.get("row", 0))[-1]
                    song_ids = _node_song_ids(last_node)
                    if song_ids:
                        song_map = {s.get("cf_id"): s for s in songs}
                        target_song = song_map.get(song_ids[0])
                if not target_song:
                    available_ids = set(r[0] for r in conn.execute(
                        "SELECT node_id FROM daily_node_commits WHERE date = ? AND install_id = ?",
                        (today, install_id),
                    ).fetchall())
                    next_nodes = [n for n in map_data.get("nodes", []) if n.get("id") in available_ids]
                    if next_nodes:
                        song_ids = _node_song_ids(next_nodes[0])
                        song_map = {s.get("cf_id"): s for s in songs}
                        target_song = song_map.get(song_ids[0]) if song_ids else None
            if not target_song:
                if cleared_ids:
                    song_map = {s.get("cf_id"): s for s in songs}
                    target_song = song_map.get(list(cleared_ids)[0])
            if not target_song and songs:
                target_song = songs[0]

            if not target_song:
                return {"error": "No song found"}, 404

            return _song_liner_notes(target_song)

        return {"error": "Unknown tab"}, 400


    @app.post("/api/plugins/the_daily/rest/{node_id}")
    async def post_rest(node_id: str, request: Request):
        install_id = _client_install_id(request=request)
        if not install_id:
            return {"error": "install_id required"}, 400
        try:
            body = await request.json()
        except Exception:
            body = {}
        action = body.get("action")

        if action != "bank":
            return {"error": "Invalid action"}, 400

        today = _get_today().isoformat()
        conn = _get_conn()

        existing = conn.execute(
            "SELECT 1 FROM daily_node_actions WHERE install_id = ? AND date = ? AND node_id = ? AND action = 'rest:bank'",
            (install_id, today, node_id),
        ).fetchone()
        if existing:
            return {"ok": True, "already_banked": True}

        cleared_count = conn.execute(
            "SELECT COUNT(*) FROM daily_completions WHERE date = ? AND install_id = ?",
            (today, install_id),
        ).fetchone()[0]

        tokens = 2 * cleared_count

        with _lock:
            conn.execute(
                "INSERT OR IGNORE INTO daily_node_actions (install_id, date, node_id, action, payload) VALUES (?, ?, ?, ?, ?)",
                (install_id, today, node_id, "rest:bank", json.dumps({"tokens": tokens, "cleared_count": cleared_count})),
            )
            conn.execute(
                "UPDATE daily_inventory SET tokens = tokens + ? WHERE install_id = ?",
                (tokens, install_id),
            )
            conn.execute(
                "INSERT INTO daily_token_ledger (install_id, date, delta, reason) VALUES (?, ?, ?, 'rest_bank')",
                (install_id, today, tokens),
            )
            conn.commit()

        return {"ok": True, "banked_tokens": tokens, "inventory": _inventory_payload(conn, install_id)}

    @app.post("/api/plugins/the_daily/nodes/{node_id}/clear")
    async def post_clear_node(node_id: str, request: Request):
        install_id = _client_install_id(request=request)
        if not install_id:
            return {"error": "install_id required"}, 400
        today = _get_today().isoformat()
        conn = _get_conn()
        
        # Stable cf_id for non-song nodes to avoid collisions and satisfy NOT NULL
        import hashlib
        h = int(hashlib.md5(node_id.encode()).hexdigest(), 16) % 1000000
        cf_id = -1000000 - h

        with _lock:
            conn.execute(
                "INSERT OR IGNORE INTO daily_completions (date, cf_id, node_id, install_id) VALUES (?, ?, ?, ?)",
                (today, cf_id, node_id, install_id),
            )
            conn.commit()
        
        return {"ok": True, "cleared": True}

    @app.get("/api/plugins/the_daily/mystery/{node_id}")
    def get_mystery_event(node_id: str, request: Request):
        install_id = _client_install_id(request=request)
        today = _get_today().isoformat()
        conn = _get_conn()

        row = conn.execute(
            "SELECT map, songs FROM daily_setlists WHERE date = ?", (today,)
        ).fetchone()
        if not row:
            return {"error": "No setlist for today"}, 404

        map_json, songs_json = row
        if not map_json:
            return {"error": "Mystery events only available in Map Mode"}, 400

        map_data = json.loads(map_json)
        nodes = _node_by_id(map_data)
        node = nodes.get(node_id)
        if not node or node.get("type") != "mystery":
            return {"error": "Not a mystery node"}, 400

        event_type = node.get("event_type")
        event_payload = node.get("event_payload")

        if not event_type or not event_payload:
            # Fallback: legacy mystery node without event
            pool = _load_pool(today, Path(__file__).parent)
            node = _enrich_mystery_node(today, node, pool)
            event_type = node.get("event_type")
            event_payload = node.get("event_payload")

        if not event_type or not event_payload:
            return {"error": "Could not determine mystery event"}, 500

        # Strip answer fields for client (they get revealed after submission)
        response = {
            "event_type": event_type,
            "event_payload": dict(event_payload),
        }
        # Remove answer fields
        if event_type == "guess_year" and "answer_year" in response["event_payload"]:
            del response["event_payload"]["answer_year"]

        return response


    @app.post("/api/plugins/the_daily/mystery/{node_id}/submit")
    async def submit_mystery_event(node_id: str, request: Request):
        install_id = _client_install_id(request=request)
        if not install_id:
            return {"error": "install_id required"}, 400

        try:
            data = await request.json()
        except Exception:
            data = {}

        today = _get_today().isoformat()
        conn = _get_conn()

        row = conn.execute(
            "SELECT map FROM daily_setlists WHERE date = ?", (today,)
        ).fetchone()
        if not row or not row[0]:
            return {"error": "No setlist for today"}, 404

        map_data = json.loads(row[0])
        nodes = _node_by_id(map_data)
        node = nodes.get(node_id)
        if not node or node.get("type") != "mystery":
            return {"error": "Not a mystery node"}, 400

        event_type = node.get("event_type")
        event_payload = node.get("event_payload")

        if not event_type or not event_payload:
            return {"error": "Mystery event not initialized"}, 500

        action = f"mystery:{event_type}:submit"
        payload = data.get("payload", {})

        with _lock:
            conn.execute(
                "INSERT OR REPLACE INTO daily_node_actions (install_id, date, node_id, action, payload) VALUES (?, ?, ?, ?, ?)",
                (install_id, today, node_id, action, json.dumps(payload)),
            )
            conn.commit()

        # Build result based on event type
        result = {"ok": True}
        if event_type == "guess_year":
            guess = payload.get("guess")
            answer = event_payload.get("answer_year")
            if guess is not None and answer is not None:
                result["correct_year"] = answer
                result["guess"] = guess
                result["delta"] = abs(int(guess) - int(answer))
        elif event_type == "blind_pick":
            result["revealed"] = True
        elif event_type == "replay":
            result["originally_seen_date"] = event_payload.get("originally_seen_date")

        return result

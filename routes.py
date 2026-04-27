"""Daily Setlist plugin — seeded global setlist inspired by Slay the Spire."""

import hashlib
from fastapi import Request
import json
import random
import re
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

# Raw GitHub URL for the pool file. Falls back to bundled songs_pool.json.
POOL_URL = "https://github.com/masc0t/slopsmith-plugin-the-daily/releases/download/pool-latest/songs_pool.json"

DEFAULT_SONG_COUNT = 5
MAP_MODE_START = date(2026, 5, 2)
BOSS_REROLL_ITEM = "boss_reroll"

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
    return date.today()


def _day_name(date_str, modifier_id, songs):
    mod = MODIFIERS[modifier_id]
    if mod["type"] == "identity":
        key = mod["key"]
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
        return (date.today() - date.fromisoformat(d)).days <= 60
    except (ValueError, TypeError):
        return False


def _is_fresh_week(song):
    d = song.get("date_added_cf")
    if not d:
        return False
    try:
        return (date.today() - date.fromisoformat(d)).days <= 7
    except (ValueError, TypeError):
        return False


def _is_vintage_upload(song):
    d = song.get("date_added_cf")
    if not d:
        return False
    try:
        return (date.today() - date.fromisoformat(d)).days >= 730
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
        return (date.today().year - int(y)) in (10, 20, 30, 40)
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


MODIFIERS = {
    "e_standard": {
        "label": "Standard Issue",
        "description": "E Standard tuning only",
        "icon": "🎸",
        "type": "filter",
        "fn": lambda s: s.get("tuning", "").lower().startswith("e standard"),
    },
    "drop_day": {
        "label": "Drop Day",
        "description": "Drop D or Drop C songs only",
        "icon": "⬇️",
        "type": "filter",
        "fn": lambda s: s.get("tuning", "").lower() in ("drop d", "drop c"),
    },
    "flat_earth": {
        "label": "Flat Earth",
        "description": "Half-step-down tunings",
        "icon": "🌍",
        "type": "filter",
        "fn": lambda s: any(s.get("tuning", "").lower().startswith(t) for t in ("eb", "ab", "db")),
    },
    "artist_takeover": {
        "label": "One Artist Takeover",
        "description": "All songs by the same artist",
        "icon": "🎤",
        "type": "identity",
        "key": "artist",
        "min_pool": 50,
    },
    "decade_night": {
        "label": "Decade Night",
        "description": "All songs from the same era",
        "icon": "📅",
        "type": "identity",
        "key": "decade",
    },
    "throwback": {
        "label": "Throwback",
        "description": "Classic era songs (pre-1985)",
        "icon": "📻",
        "type": "filter",
        "fn": lambda s: bool(s.get("year")) and int(s["year"]) < 1985,
    },
    "new_blood": {
        "label": "New Blood",
        "description": "Songs added to CF in the last 60 days",
        "icon": "🆕",
        "type": "filter",
        "fn": _is_new_blood,
    },
    "blindside": {
        "label": "Blindside",
        "description": "Song titles hidden until you play them",
        "icon": "🙈",
        "type": "ui",
    },
    "fresh_off_the_press": {
        "label": "Fresh Off the Press",
        "description": "CDLC added in the last 7 days",
        "icon": "📰",
        "type": "filter",
        "fn": _is_fresh_week,
    },
    "vintage_chart": {
        "label": "Vintage Chart",
        "description": "CDLC uploaded to CF over 2 years ago",
        "icon": "📜",
        "type": "filter",
        "fn": _is_vintage_upload,
    },
    "album_side": {
        "label": "Album Side",
        "description": "All songs from the same album",
        "icon": "💿",
        "type": "identity",
        "key": "album",
        "min_pool": 4,
    },
    "class_reunion": {
        "label": "Class Reunion",
        "description": "All songs from the same release year",
        "icon": "🎓",
        "type": "identity",
        "key": "year",
        "min_pool": 5,
    },
    "discography": {
        "label": "Discography",
        "description": "Same artist, each song from a different album",
        "icon": "📚",
        "type": "composite",
        "rules": ["identity:artist", "unique:album"],
    },
    "time_machine": {
        "label": "Time Machine",
        "description": "One song per decade, oldest to newest",
        "icon": "⏳",
        "type": "composite",
        "rules": ["unique:decade", "order:year"],
    },
    "counterclockwise": {
        "label": "Counterclockwise",
        "description": "Setlist ordered newest release to oldest",
        "icon": "🔄",
        "type": "ordering",
        "key": lambda s: -int(s.get("year") or 0),
    },
    "alphabet_soup": {
        "label": "Alphabet Soup",
        "description": "Song titles in alphabetical order",
        "icon": "🔤",
        "type": "ordering",
        "key": lambda s: s.get("title", "").lower(),
    },
    "title_chain": {
        "label": "Title Chain",
        "description": "Each title starts with the last word of the previous",
        "icon": "🔗",
        "type": "sequence",
        "fn": _title_chains,
    },
    "one_word": {
        "label": "One Word",
        "description": "All song titles are a single word",
        "icon": "1️⃣",
        "type": "filter",
        "fn": lambda s: len(s.get("title", "").split()) == 1,
    },
    "verbose": {
        "label": "Verbose",
        "description": "Titles must be five words or longer",
        "icon": "📜",
        "type": "filter",
        "fn": lambda s: len(s.get("title", "").split()) >= 5,
    },
    "number_station": {
        "label": "Number Station",
        "description": "Every title contains a number",
        "icon": "🔢",
        "type": "filter",
        "fn": lambda s: any(c.isdigit() for c in s.get("title", "")),
    },
    "punctuated": {
        "label": "Punctuated",
        "description": "Titles with question marks, exclamations, or parentheses",
        "icon": "❓",
        "type": "filter",
        "fn": lambda s: any(c in s.get("title", "") for c in "?!()"),
    },
    "witching_hour": {
        "label": "Witching Hour",
        "description": "Dark themes: death, fire, blood, ghosts",
        "icon": "🕯️",
        "type": "filter",
        "fn": lambda s: _title_has_keywords(s, {"death", "dead", "ghost", "fire", "blood", "devil", "grave", "hell", "kill", "pain", "dark"}),
    },
    "love_letter": {
        "label": "Love Letter",
        "description": "Titles about love, heartbreak, or longing",
        "icon": "💌",
        "type": "filter",
        "fn": lambda s: _title_has_keywords(s, {"love", "heart", "kiss", "baby", "goodbye", "missing", "lonely"}),
    },
    "shared_letter": {
        "label": "Shared Letter",
        "description": "Every artist name starts with the same letter",
        "icon": "🅰️",
        "type": "identity",
        "key": lambda s: s.get("artist", "")[:1].upper(),
        "min_pool": 8,
    },
    "palette_swap": {
        "label": "Palette Swap",
        "description": "Each song in a different tuning family from the last",
        "icon": "🎨",
        "type": "sequence",
        "fn": lambda prev, curr: _tuning_family(prev) != _tuning_family(curr),
    },
    "dealers_choice": {
        "label": "Dealer's Choice",
        "description": "A random modifier is picked and kept secret",
        "icon": "🃏",
        "type": "meta",
    },
    "double_trouble": {
        "label": "Double Trouble",
        "description": "Two modifiers stack for this setlist",
        "icon": "♠️",
        "type": "meta",
        "count": 2,
    },
    "leap_year": {
        "label": "Leap Year",
        "description": "Songs released exactly 10, 20, 30, or 40 years ago today",
        "icon": "🦘",
        "type": "filter",
        "fn": _is_anniversary_year,
    },
    "prime_time": {
        "label": "Prime Time",
        "description": "Songs released in a prime-numbered year",
        "icon": "🔱",
        "type": "filter",
        "fn": lambda s: _is_prime(int(s.get("year") or 0)),
    },
    "typecast": {
        "label": "Typecast",
        "description": "Every title starts with the same letter",
        "icon": "🔠",
        "type": "identity",
        "key": lambda s: s.get("title", "")[:1].upper(),
        "min_pool": 8,
    },
    "bookends": {
        "label": "Bookends",
        "description": "First and last song are by the same artist",
        "icon": "📚",
        "type": "structural",
        "shape": "bookend",
        "key": "artist",
    },
    "escalating_era": {
        "label": "Escalating Era",
        "description": "Each song newer than the last, no duplicates by year",
        "icon": "🪜",
        "type": "composite",
        "rules": ["unique:year", "order:year"],
    },
    "compound_word": {
        "label": "Compound Word",
        "description": "Every title is exactly two words",
        "icon": "🔗",
        "type": "filter",
        "fn": lambda s: len(s.get("title", "").split()) == 2,
    },
    "rorschach": {
        "label": "Rorschach",
        "description": "Titles contain body parts: heart, eye, hand, blood, bone",
        "icon": "👁️",
        "type": "filter",
        "fn": lambda s: _title_has_keywords(s, {"heart", "eye", "eyes", "hand", "hands", "blood", "bone", "bones", "skin", "face", "soul", "mind", "head"}),
    },
    "weather_report": {
        "label": "Weather Report",
        "description": "Titles reference weather or sky: rain, storm, sun, moon, cloud",
        "icon": "⛈️",
        "type": "filter",
        "fn": lambda s: _title_has_keywords(s, {"rain", "storm", "sun", "moon", "cloud", "wind", "thunder", "lightning", "snow", "sky", "star", "stars"}),
    },
    "color_wheel": {
        "label": "Color Wheel",
        "description": "Every title contains a color",
        "icon": "🌈",
        "type": "filter",
        "fn": lambda s: _title_has_keywords(s, {"red", "blue", "green", "black", "white", "gold", "silver", "yellow", "purple", "orange", "gray", "grey", "crimson"}),
    },
    "motion_picture": {
        "label": "Motion Picture",
        "description": "Titles with verbs of movement: run, fly, fall, dance, walk",
        "icon": "🏃",
        "type": "filter",
        "fn": lambda s: _title_has_keywords(s, {"run", "running", "fly", "flying", "fall", "falling", "dance", "dancing", "walk", "walking", "jump", "drive"}),
    },
    "reanimated": {
        "label": "Reanimated",
        "description": "Same album appeared in a prior daily in the last 30 days",
        "icon": "🧟",
        "type": "meta",
    },
    "secret_handshake": {
        "label": "Secret Handshake",
        "description": "All songs share a hidden attribute; guess what it is to complete",
        "icon": "🤝",
        "type": "meta",
    },
    "rival_camps": {
        "label": "Rival Camps",
        "description": "Two artists only, alternating songs",
        "icon": "⚔️",
        "type": "structural",
        "shape": "alternating",
        "key": "artist",
    },
    "sundown": {
        "label": "Sundown",
        "description": "Titles reference endings: last, final, end, goodbye, over",
        "icon": "🌅",
        "type": "filter",
        "fn": lambda s: _title_has_keywords(s, {"last", "final", "end", "ending", "goodbye", "over", "gone", "forever", "never"}),
    },
    "title_track": {
        "label": "Title Track",
        "description": "Song title matches the album title",
        "icon": "🎯",
        "type": "filter",
        "fn": lambda s: s.get("title", "").strip().lower() == s.get("album", "").strip().lower(),
    },
}


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
                song_count INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS daily_completions (
                date         TEXT NOT NULL,
                cf_id        INTEGER NOT NULL,
                completed_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (date, cf_id)
            );
            CREATE TABLE IF NOT EXISTS pool_cache (
                fetched_date TEXT PRIMARY KEY,
                pool         TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS daily_inventory (
                install_id TEXT PRIMARY KEY,
                items TEXT NOT NULL DEFAULT '[]',
                last_streak_milestone INTEGER NOT NULL DEFAULT 0,
                starter_awarded INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT
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
        """)
        _ensure_column(_conn, "daily_setlists", "map", "TEXT")
        _ensure_column(_conn, "daily_setlists", "fallback", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(_conn, "daily_completions", "node_id", "TEXT")
        _ensure_column(_conn, "daily_completions", "install_id", "TEXT")
        _ensure_column(_conn, "daily_inventory", "starter_awarded", "INTEGER NOT NULL DEFAULT 0")
        _conn.commit()
    return _conn


def _ensure_column(conn, table, column, ddl):
    cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


# ── Pool loading ──────────────────────────────────────────────────────────────
def _load_pool(date_str, plugin_dir):
    conn = _get_conn()
    row = conn.execute(
        "SELECT pool FROM pool_cache WHERE fetched_date = ?", (date_str,)
    ).fetchone()
    if row:
        return json.loads(row[0])

    pool = None
    if POOL_URL:
        try:
            req = urllib.request.Request(POOL_URL)
            req.add_header("User-Agent", "slopsmith-daily/1.0")
            with urllib.request.urlopen(req, timeout=10) as resp:
                pool = json.loads(resp.read())
        except Exception:
            pass

    if pool is None:
        bundled = Path(plugin_dir) / "songs_pool.json"
        if bundled.exists():
            with open(bundled) as f:
                pool = json.load(f)

    if pool:
        pool = [s for s in pool
                if len((s.get("artist") or "").strip()) >= 2
                and len((s.get("title") or "").strip()) >= 2
                and "full album" not in (s.get("title") or "").lower()]
        with _lock:
            conn.execute(
                "INSERT OR REPLACE INTO pool_cache (fetched_date, pool) VALUES (?, ?)",
                (date_str, json.dumps(pool))
            )
            conn.commit()

    return pool or []


# ── Modifier selection ────────────────────────────────────────────────────────
def _pick_modifier(date_str):
    rng = random.Random(_date_seed(date_str))
    keys = list(MODIFIERS.keys())
    rng.shuffle(keys)
    return keys[0]


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


def _select_composite(date_str, modifier_id, pool, count):
    """composite: chain of rules like identity:field, unique:field, order:field."""
    mod = MODIFIERS[modifier_id]
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


def _select_sequence(date_str, modifier_id, pool, count):
    """sequence: each adjacent pair must satisfy fn(prev, curr)."""
    mod = MODIFIERS[modifier_id]
    fn = mod["fn"]
    rng = random.Random(_date_seed(date_str) + modifier_id + "seq")

    shuffled = list(pool)
    rng.shuffle(shuffled)

    # Try up to 200 random starting positions
    for start in range(min(200, len(shuffled))):
        chain = [shuffled[start]]
        remaining = shuffled[:start] + shuffled[start + 1:]
        for _ in range(count - 1):
            for i, s in enumerate(remaining):
                if fn(chain[-1], s):
                    chain.append(s)
                    remaining.pop(i)
                    break
            else:
                break
        if len(chain) >= count:
            return chain[:count], count, False

    return _fallback_sample(pool, count, date_str, modifier_id)


def _select_structural(date_str, modifier_id, pool, count):
    """structural: enforces positional shapes (bookend, alternating)."""
    mod = MODIFIERS[modifier_id]
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


def _select_meta(date_str, modifier_id, pool, count, exclude=None):
    """meta: delegates or wraps other modifiers."""
    non_meta = [k for k, m in MODIFIERS.items() if m["type"] != "meta"]
    rng = random.Random(_date_seed(date_str) + modifier_id + "meta")

    if modifier_id == "dealers_choice":
        chosen = rng.choice(non_meta)
        return _select_songs(date_str, chosen, pool, exclude=exclude)

    if modifier_id == "double_trouble":
        chosen = rng.sample(non_meta, 2)
        candidates = list(pool)
        for mid in chosen:
            m = MODIFIERS[mid]
            if m["type"] == "filter":
                filtered = [s for s in candidates if m["fn"](s)]
                if len(filtered) >= count:
                    candidates = filtered
        rng2 = random.Random(_date_seed(date_str) + "songs")
        selected = rng2.sample(candidates, min(count, len(candidates)))
        return selected, len(selected), False

    # reanimated, secret_handshake — random selection
    rng2 = random.Random(_date_seed(date_str) + "songs")
    selected = rng2.sample(pool, min(count, len(pool)))
    return selected, len(selected), False


def _select_songs(date_str, modifier_id, pool, exclude=None):
    mod = MODIFIERS[modifier_id]
    mod_type = mod["type"]
    count = mod.get("count", DEFAULT_SONG_COUNT)
    fallback = False

    if mod_type in ("filter", "filter+count"):
        candidates = [s for s in pool if mod["fn"](s)]
        if len(candidates) < count:
            candidates = pool
            fallback = True
    elif mod_type == "identity":
        candidates, fallback = _identity_candidates(
            date_str, pool, mod["key"], count, mod.get("min_pool"),
            exclude=exclude, seed_suffix=modifier_id,
        )
        count = DEFAULT_SONG_COUNT
    elif mod_type == "composite":
        return _select_composite(date_str, modifier_id, pool, count)
    elif mod_type == "ordering":
        candidates = list(pool)
    elif mod_type == "sequence":
        return _select_sequence(date_str, modifier_id, pool, count)
    elif mod_type == "structural":
        return _select_structural(date_str, modifier_id, pool, count)
    elif mod_type == "meta":
        return _select_meta(date_str, modifier_id, pool, count, exclude=exclude)
    else:
        candidates = pool

    rng = random.Random(_date_seed(date_str) + "songs")
    selected = rng.sample(candidates, min(count, len(candidates)))

    if mod_type == "ordering" and callable(mod.get("key")):
        try:
            selected = sorted(selected, key=mod["key"])
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


def _map_modifier_pool(date_str, modifier_id, pool, exclude=None):
    mod = MODIFIERS[modifier_id]
    count = mod.get("count", DEFAULT_SONG_COUNT)
    fallback = False

    if mod["type"] in ("filter", "filter+count"):
        candidates = [s for s in pool if mod["fn"](s)]
        if len(candidates) < count:
            return pool, True
        return candidates, False

    if mod["type"] == "identity":
        candidates, fallback = _identity_candidates(
            date_str, pool, mod["key"], count, mod.get("min_pool"),
            exclude=exclude, seed_suffix=modifier_id + "map",
        )
        return candidates, fallback

    return pool, False


def _boss_eligible(song):
    duration = _song_duration_seconds(song)
    return (
        duration is not None
        and duration >= 240
        and bool((song.get("artist") or "").strip())
        and bool(song.get("year"))
    )


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
        "fn": lambda s: _song_duration_seconds(s) is not None and _song_duration_seconds(s) > 240,
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


def _build_spiral_map(date_str, modifier_id, pool, fallback):
    rng = random.Random(_date_seed(date_str) + modifier_id + "mapfallback")
    nodes = _assign_map_node_types(_map_shape_template("spiral"), rng)
    boss_pool = [s for s in pool if _boss_eligible(s)] or pool
    if not boss_pool:
        return None, [], True

    boss = rng.choice(boss_pool)
    used_cf_ids = {boss["cf_id"]}
    songs = {boss["cf_id"]: boss}

    for node in nodes:
        node.pop("lane_slot", None)
        node["lane"] = None if node["id"] == "nb" else "daily"
        if node["id"] == "nb":
            node["cf_id"] = boss["cf_id"]
            continue
        need = _node_song_need(node)
        picked = _sample_unused(rng, pool, need, used_cf_ids)
        if not picked:
            return None, [], True
        for song in picked:
            songs[song["cf_id"]] = song
        if node["type"] == "choice":
            node["cf_ids"] = [s["cf_id"] for s in picked]
        elif node["type"] == "mystery":
            node["cf_pool"] = [s["cf_id"] for s in picked]
        else:
            node["cf_id"] = picked[0]["cf_id"]

    mod = MODIFIERS[modifier_id]
    return {
        "shape": "spiral",
        "start": "n0",
        "boss": "nb",
        "nodes": nodes,
        "lanes": {"daily": mod.get("icon", "")},
    }, list(songs.values()), fallback


ACTS = ['Act 1', 'Act 2', 'Act 3']
    modifier_pool, modifier_fallback = _map_modifier_pool(date_str, modifier_id, pool, exclude=exclude)
    if len(modifier_pool) < 6:
        return _build_spiral_map(date_str, modifier_id, pool, True)

    mod = MODIFIERS[modifier_id]
    collapse_to_spiral = mod["type"] == "identity"
    rng = random.Random(_date_seed(date_str) + modifier_id + "map")
    shape = "spiral" if collapse_to_spiral else _weighted_choice(rng, MAP_SHAPE_WEIGHTS)
    nodes = _assign_map_node_types(_map_shape_template(shape), rng)

    boss_pool = [s for s in modifier_pool if _boss_eligible(s)]
    if not boss_pool:
        return _build_spiral_map(date_str, modifier_id, pool, True)
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
            return _build_spiral_map(date_str, modifier_id, pool, True)
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
    
    # Assign acts to forced nodes based on their row order
    if forced_nodes_in_row:
        # Sort rows to determine act progression
        rows = sorted(forced_nodes_in_row.keys())
        for row_index, row in enumerate(rows):
            for node in forced_nodes_in_row[row]:
                node["act"] = f"AC_{row_index + 1}"
                node["row"] = node["row"] + row_index * 3  # Space out rows for each act
    else:
        # Fallback if no forced nodes found
        for node in nodes:
            if node["id"] == "n0":
                node["act"] = "AC_1"
            elif node["id"] == "fb":
                node["act"] = "AC_2"
                node["row"] += 3
            elif node["id"] == "n1" or node["id"] == "n2":
                node["act"] = "AC_1"
            else:
                node["act"] = "AC_1"

    for node in nodes:
        slot = node.pop("lane_slot", None)
        lane_id = slot_to_lane.get(slot)
        node["lane"] = lane_id
        if node["id"] == "nb":
            node["cf_id"] = boss["cf_id"]
            continue

        need = _node_song_need(node)
        if lane_id and not collapse_to_spiral:
            candidates = lane_candidate_map[lane_id]
        else:
            candidates = modifier_pool
        picked = _sample_unused(rng, candidates, need, used_cf_ids)
        if not picked:
            return _build_spiral_map(date_str, modifier_id, pool, True)
        for song in picked:
            songs[song["cf_id"]] = song
        if node["type"] == "choice":
            node["cf_ids"] = [s["cf_id"] for s in picked]
        elif node["type"] == "mystery":
            node["cf_pool"] = [s["cf_id"] for s in picked]
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
    if collapse_to_spiral:
        lanes[modifier_id] = mod.get("icon", "")
    else:
        # Group lanes by ACT type for proper routing
        lane_act_map = {}
        for lane_id in lane_ids:
            # Get the first node to determine ACT type
            lane_info = nodes_by_lane.get(lane_id, {})
            sample_node = lane_info.get("first_node")
            if sample_node and sample_node.get("type") in ["forced", "elite", "treasure", "rest", "shop"]:
                lane_act_map[lane_id] = sample_node.get("act", "AC_1")
            else:
                lane_act_map[lane_id] = "AC_1"
            lanes[lane_id] = lane_icon_map[lane_id]
        # Add ACT labels to each lane
        lanes["act_labels"] = lane_act_map

    return {
        "shape": shape,
        "start": "n0",
        "boss": "nb",
        "nodes": nodes,
        "lanes": lanes,
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
        return {"items": [], "counts": {}}
    row = conn.execute(
        "SELECT items FROM daily_inventory WHERE install_id = ?", (install_id,)
    ).fetchone()
    if not row:
        with _lock:
            conn.execute(
                "INSERT OR IGNORE INTO daily_inventory (install_id, items, updated_at) VALUES (?, '[]', datetime('now'))",
                (install_id,),
            )
            conn.commit()
        items = []
    else:
        try:
            items = json.loads(row[0] or "[]")
        except Exception:
            items = []
    counts = {}
    for item in items:
        counts[item] = counts.get(item, 0) + 1
    return {"items": items, "counts": counts}


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
    for node_id in committed - cleared:
        node = nodes.get(node_id)
        if not node:
            continue
        row = node.get("row")
        locked.update(
            n["id"] for n in nodes.values()
            if n.get("row") == row and n.get("id") != node_id and n.get("id") not in cleared
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
    for node_id in committed - cleared:
        node = nodes.get(node_id)
        if not node:
            continue
        row = node.get("row")
        locked.update(
            n["id"] for n in nodes.values()
            if n.get("row") == row and n.get("id") != node_id and n.get("id") not in cleared
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
        "WHERE artist LIKE ? COLLATE NOCASE LIMIT 20",
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
        debug_map = request.query_params.get("debug_map") in ("1", "true", "yes")
        if debug_map and request.query_params.get("debug_date"):
            try:
                today = date.fromisoformat(request.query_params.get("debug_date")).isoformat()
                today_date = date.fromisoformat(today)
            except Exception:
                today = real_today
                today_date = date.fromisoformat(today)
        conn = _get_conn()

        row = conn.execute(
            "SELECT day_name, modifier, songs, song_count, map, fallback FROM daily_setlists WHERE date = ?",
            (today,),
        ).fetchone()

        fallback = False
        map_data = None
        if debug_map:
            pool = _load_pool(today, plugin_dir)
            if not pool:
                return {"error": "Song pool is empty. Run build_pool.py to populate it."}
            modifier_id = _pick_modifier(today)
            active_pool = _daily_active_pool(conn, today, pool)
            exclude = _daily_artist_exclude(conn, today, modifier_id)
            map_data, songs, fallback = _build_map(today, modifier_id, active_pool, exclude=exclude)
            song_count = 1
            day_name = _day_name(today, modifier_id, songs)
        elif row:
            day_name, modifier_id, songs_json, song_count, map_json, fallback_int = row
            songs = json.loads(songs_json)
            map_data = json.loads(map_json) if map_json else None
            fallback = bool(fallback_int)
        else:
            pool = _load_pool(today, plugin_dir)
            if not pool:
                return {"error": "Song pool is empty. Run build_pool.py to populate it."}

            modifier_id = _pick_modifier(today)

            active_pool = _daily_active_pool(conn, today, pool)
            exclude = _daily_artist_exclude(conn, today, modifier_id)
            if today_date >= MAP_MODE_START:
                map_data, songs, fallback = _build_map(today, modifier_id, active_pool, exclude=exclude)
                song_count = 1
            else:
                songs, song_count, fallback = _select_songs(today, modifier_id, active_pool, exclude=exclude)
            day_name = _day_name(today, modifier_id, songs)

            with _lock:
                conn.execute(
                    "INSERT OR IGNORE INTO daily_setlists "
                    "(date, day_name, modifier, songs, song_count, map, fallback) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (today, day_name, modifier_id, json.dumps(songs), song_count, json.dumps(map_data) if map_data else None, 1 if fallback else 0),
                )
                conn.commit()

        map_data, songs, used_reroll = (map_data, songs, False) if debug_map else _apply_boss_reroll(conn, today, map_data, songs, install_id)

        done_ids = set() if debug_map else {r[0] for r in conn.execute("SELECT cf_id FROM daily_completions WHERE date = ?", (today,)).fetchall()}

        mod = MODIFIERS[modifier_id]
        enriched = _enrich_songs(meta_db, songs, done_ids)
        map_state = _map_available_state(conn, today, map_data, None if debug_map else install_id) if map_data else None
        is_complete = map_state["is_complete"] if map_state else len(done_ids) >= song_count
        progress_done = len(map_state["cleared_node_ids"]) if map_state else len(done_ids)
        progress_total = len(map_data.get("nodes", [])) if map_data else song_count

        day_number = (date.fromisoformat(today) - _EPOCH).days + 1
        has_unavailable = any(not s["has_locally"] for s in enriched)
        payload = {
            "date": today,
            "seed": _date_seed(today),
            "day_name": day_name,
            "day_number": day_number,
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
            "has_unavailable": has_unavailable,
            "map": map_data,
            "used_reroll": used_reroll,
            "inventory": {"items": [BOSS_REROLL_ITEM] * 99, "counts": {BOSS_REROLL_ITEM: 99}} if debug_map else _inventory_payload(conn, install_id),
            "debug_no_save": debug_map,
            "debug_real_today": real_today if debug_map else None,
        }
        if map_state:
            payload.update(map_state)
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
            mod_id = _pick_modifier(target_date_str)
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
                map_data, songs, fallback = _build_map(target_date_str, mod_id, active_pool, exclude=exclude)
                song_count = 1
            else:
                songs, song_count, fallback = _select_songs(target_date_str, mod_id, active_pool, exclude=exclude)
            day_name = _day_name(target_date_str, mod_id, songs)

            # Enrich songs with local availability
            enriched = []
            for s in songs:
                s2 = dict(s)
                s2["local_filename"] = _find_locally(meta_db, s2)
                s2["has_locally"] = s2["local_filename"] is not None
                enriched.append(s2)
            progress_total = len(map_data.get("nodes", [])) if map_data else song_count
            day_number = (targ - _EPOCH).days + 1
            return {
                "date": target_date_str,
                "seed": _date_seed(target_date_str),
                "day_name": day_name,
                "day_number": day_number,
                "modifier": {
                    "id": mod_id,
                    "label": MODIFIERS[mod_id]["label"],
                    "description": MODIFIERS[mod_id]["description"],
                    "icon": MODIFIERS[mod_id].get("icon", ""),
                    "is_blindside": MODIFIERS[mod_id]["type"] == "ui",
                },
                "fallback": fallback,
                "songs": enriched,
                "song_count": song_count,
                "progress": {"done": 0, "total": progress_total},
                "is_complete": False,
                "has_unavailable": False,
                "is_historical": True,
                "map": map_data,
            }

        # Helper to build payload from a retrieved row
        def build_payload(row, is_historical: bool, mod_id, songs, song_count, done_ids=None, map_data=None, fallback=False):
            if not row:
                return None
            day_name = row[0]
            modifier_id = mod_id
            if isinstance(modifier_id, tuple):
                modifier_id = modifier_id[0]
            mod = MODIFIERS[modifier_id]
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
            progress_total = len(map_data.get("nodes", [])) if map_data else song_count
            return {
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
                **(map_state or {}),
            }

        # Today
        row = conn.execute(
            "SELECT day_name, modifier, songs, song_count, map, fallback FROM daily_setlists WHERE date = ?",
            (date_str,),
        ).fetchone()
        if target == today_date:
            if not row:
                return {"error": "No setlist for today"}, 404
            day_name, modifier_id, songs_json, song_count, map_json, fallback_int = row
            songs = json.loads(songs_json)
            map_data = json.loads(map_json) if map_json else None
            # Enrich completion state for today
            done_ids = {r[0] for r in conn.execute("SELECT cf_id FROM daily_completions WHERE date = ?", (date_str,)).fetchall()}
            payload = build_payload(row, False, modifier_id, songs, song_count, done_ids, map_data=map_data, fallback=bool(fallback_int))
            return payload

        # Historical
        if row:
            day_name, modifier_id, songs_json, song_count, map_json, fallback_int = row
            songs = json.loads(songs_json)
            map_data = json.loads(map_json) if map_json else None
            done_ids = {r[0] for r in conn.execute("SELECT cf_id FROM daily_completions WHERE date = ?", (date_str,)).fetchall()}
            payload = build_payload(row, True, modifier_id, songs, song_count, done_ids, map_data=map_data, fallback=bool(fallback_int))
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
        debug_no_save = bool(data.get("debug_no_save"))
        duration_played = data.get("duration_played", 0)
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
        debug_no_save = bool(data.get("debug_no_save"))
        if not install_id:
            return {"error": "install_id required"}
        if item_id != BOSS_REROLL_ITEM:
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
        original_cf_id = boss_node.get("cf_id") if boss_node else None
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

    @app.get("/api/plugins/the_daily/streak")
    def get_streak():
        conn = _get_conn()
        return {"streak": _compute_streak(conn, _get_today().isoformat())}

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
    def get_leaderboard(date: str = None):
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
        row = conn.execute(
            "SELECT day_name, modifier FROM daily_setlists WHERE date = ?", (target.isoformat(),)
        ).fetchone()
        # Compute the day number without relying on date.fromisoformat to avoid name shadowing issues
        day_num = (target - _EPOCH).days + 1
        day_name = row[0] if row else f"Daily #{day_num}"
        modifier_id = row[1] if row and len(row) > 1 else None
        seed = _date_seed(target.isoformat()) if target else None
        fallback = False

        mod = MODIFIERS[modifier_id] if modifier_id else {}
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
            entries = _supabase_get(
                "/rest/v1/leaderboard",
                {
                    "date": f"eq.{target.isoformat()}",
                    "order": "completed_at.asc",
                    "select": "*",
                },
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

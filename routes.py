"""Daily Setlist plugin — seeded global setlist inspired by Slay the Spire."""

import hashlib
import json
import random
import re
import sqlite3
import threading
import urllib.request
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

# Leaderboard protection
NAME_MIN_LENGTH = 2
NAME_MAX_LENGTH = 20
IP_DAILY_LIMIT = 5
STREAK_LOOKBACK_DAYS = 30

# ── Day name ──────────────────────────────────────────────────────────────────
_EPOCH = date(2026, 4, 22)


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
        """)
        _conn.commit()
    return _conn


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
        if _normalize_title(local_title) == norm:
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
    def get_today():
        today = date.today().isoformat()
        conn = _get_conn()

        row = conn.execute(
            "SELECT day_name, modifier, songs, song_count FROM daily_setlists WHERE date = ?",
            (today,),
        ).fetchone()

        fallback = False
        if row:
            day_name, modifier_id, songs_json, song_count = row
            songs = json.loads(songs_json)
        else:
            pool = _load_pool(today, plugin_dir)
            if not pool:
                return {"error": "Song pool is empty. Run build_pool.py to populate it."}

            modifier_id = _pick_modifier(today)

            # Exclude songs played in the last 14 days
            used_cf_ids = set()
            for i in range(1, 15):
                past = (date.fromisoformat(today) - timedelta(days=i)).isoformat()
                past_row = conn.execute(
                    "SELECT songs FROM daily_setlists WHERE date = ?", (past,)
                ).fetchone()
                if past_row:
                    for s in json.loads(past_row[0]):
                        used_cf_ids.add(s["cf_id"])
            fresh_pool = [s for s in pool if s["cf_id"] not in used_cf_ids]
            active_pool = fresh_pool if len(fresh_pool) >= DEFAULT_SONG_COUNT else pool

            # Exclude recently used artists for artist_takeover
            exclude = None
            if modifier_id == "artist_takeover":
                exclude = set()
                for i in range(1, 15):
                    past = (date.fromisoformat(today) - timedelta(days=i)).isoformat()
                    past_row = conn.execute(
                        "SELECT modifier, songs FROM daily_setlists WHERE date = ?", (past,)
                    ).fetchone()
                    if past_row and past_row[0] == "artist_takeover":
                        past_songs = json.loads(past_row[1])
                        if past_songs:
                            exclude.add((past_songs[0].get("artist") or "").lower())
            songs, song_count, fallback = _select_songs(today, modifier_id, active_pool, exclude=exclude)
            day_name = _day_name(today, modifier_id, songs)

            with _lock:
                conn.execute(
                    "INSERT OR IGNORE INTO daily_setlists "
                    "(date, day_name, modifier, songs, song_count) VALUES (?, ?, ?, ?, ?)",
                    (today, day_name, modifier_id, json.dumps(songs), song_count),
                )
                conn.commit()

        done_ids = {
            r[0]
            for r in conn.execute(
                "SELECT cf_id FROM daily_completions WHERE date = ?", (today,)
            ).fetchall()
        }

        mod = MODIFIERS[modifier_id]
        enriched = []
        for song in songs:
            s = dict(song)
            s["local_filename"] = _find_locally(meta_db, s)
            s["has_locally"] = s["local_filename"] is not None
            s["done"] = s["cf_id"] in done_ids
            enriched.append(s)

        day_number = (date.fromisoformat(today) - _EPOCH).days + 1
        has_unavailable = any(not s["has_locally"] for s in enriched)
        return {
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
            "progress": {"done": len(done_ids), "total": song_count},
            "is_complete": len(done_ids) >= song_count,
            "has_unavailable": has_unavailable,
        }

    @app.post("/api/plugins/the_daily/mark")
    def mark_song(data: dict):
        cf_id = data.get("cf_id")
        if not cf_id:
            return {"error": "cf_id required"}
        today = date.today().isoformat()
        conn = _get_conn()

        row = conn.execute(
            "SELECT song_count FROM daily_setlists WHERE date = ?", (today,)
        ).fetchone()
        if not row:
            return {"error": "No setlist for today"}
        song_count = row[0]

        with _lock:
            conn.execute(
                "INSERT OR IGNORE INTO daily_completions (date, cf_id) VALUES (?, ?)",
                (today, cf_id),
            )
            conn.commit()

        done = conn.execute(
            "SELECT COUNT(*) FROM daily_completions WHERE date = ?", (today,)
        ).fetchone()[0]

        return {
            "ok": True,
            "progress": {"done": done, "total": song_count},
            "is_complete": done >= song_count,
        }

    @app.get("/api/plugins/the_daily/streak")
    def get_streak():
        conn = _get_conn()
        return {"streak": _compute_streak(conn, date.today().isoformat())}

    @app.get("/api/plugins/the_daily/leaderboard")
    def get_leaderboard(date_param: str = None):
        target = date_param or date.today().isoformat()
        conn = _get_conn()
        row = conn.execute(
            "SELECT day_name FROM daily_setlists WHERE date = ?", (target,)
        ).fetchone()
        day_name = row[0] if row else f"Daily #{(date.fromisoformat(target) - _EPOCH).days + 1}"

        if not SUPABASE_URL or SUPABASE_URL.startswith("https://YOURPROJECT"):
            return {
                "date": target,
                "day_name": day_name,
                "entries": [],
                "error": "Supabase not configured",
            }

        try:
            entries = _supabase_get(
                "/rest/v1/leaderboard",
                {
                    "date": f"eq.{target}",
                    "order": "completed_at.asc",
                    "select": "display_name,completed_at,streak,rating",
                },
            )
        except Exception as e:
            return {"date": target, "day_name": day_name, "entries": [], "error": str(e)}

        ratings = {-1: 0, 1: 0, 2: 0}
        for e in entries:
            r = e.get("rating")
            if r in ratings:
                ratings[r] += 1

        return {"date": target, "day_name": day_name, "entries": entries, "ratings": ratings}

    @app.post("/api/plugins/the_daily/sign")
    def sign_leaderboard(data: dict, request):
        display_name = (data.get("display_name") or "").strip()
        valid, err = _validate_display_name(display_name)
        if not valid:
            return {"error": err}
        rating = data.get("rating")
        if rating not in (-1, 1, 2):
            rating = None

        if not SUPABASE_URL or SUPABASE_URL.startswith("https://YOURPROJECT"):
            return {"error": "Supabase not configured"}

        today = date.today()
        today_str = today.isoformat()
        conn = _get_conn()

        row = conn.execute(
            "SELECT song_count FROM daily_setlists WHERE date = ?", (today_str,)
        ).fetchone()
        if not row:
            return {"error": "No setlist for today"}

        done = conn.execute(
            "SELECT COUNT(*) FROM daily_completions WHERE date = ?", (today_str,)
        ).fetchone()[0]
        if done < row[0]:
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
        if rating is not None:
            body["rating"] = rating
        try:
            _supabase_post("/rest/v1/leaderboard", body)
        except Exception as e:
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

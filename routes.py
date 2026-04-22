"""Daily Setlist plugin — seeded global setlist inspired by Slay the Spire."""

import json
import random
import sqlite3
import threading
import urllib.request
import urllib.error
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
# Set these after creating your Supabase project (see README / plan).
SUPABASE_URL = "https://YOURPROJECT.supabase.co"
SUPABASE_ANON_KEY = "YOUR_ANON_KEY_HERE"

# Raw GitHub URL for the pool file. Falls back to bundled songs_pool.json.
POOL_URL = ""

DEFAULT_SONG_COUNT = 5

# ── Day name ──────────────────────────────────────────────────────────────────
_EPOCH = date(2026, 1, 1)


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
    },
    "decade_night": {
        "label": "Decade Night",
        "description": "All songs from the same era",
        "icon": "📅",
        "type": "identity",
        "key": "decade",
    },
    "full_album": {
        "label": "Full Album Night",
        "description": "All songs from the same album",
        "icon": "💿",
        "type": "identity",
        "key": "album",
    },
    "throwback": {
        "label": "Throwback",
        "description": "Classic era songs (pre-1985)",
        "icon": "📻",
        "type": "filter",
        "fn": lambda s: bool(s.get("year")) and int(s["year"]) < 1985,
    },
    "speed_run": {
        "label": "Speed Run",
        "description": "7 songs, all under 2:30",
        "icon": "⚡",
        "type": "filter+count",
        "fn": lambda s: bool(s.get("duration")) and s["duration"] < 150,
        "count": 7,
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
        with _lock:
            conn.execute(
                "INSERT OR REPLACE INTO pool_cache (fetched_date, pool) VALUES (?, ?)",
                (date_str, json.dumps(pool))
            )
            conn.commit()

    return pool or []


# ── Modifier selection ────────────────────────────────────────────────────────
def _pick_modifier(date_str):
    rng = random.Random(date_str + ":mod")
    keys = list(MODIFIERS.keys())
    rng.shuffle(keys)
    return keys[0]


def _identity_candidates(date_str, pool, key, count):
    rng = random.Random(date_str + f":{key}")

    if key == "decade":
        groups = {}
        for s in pool:
            y = s.get("year")
            if y:
                decade = (int(y) // 10) * 10
                groups.setdefault(decade, []).append(s)
    else:
        groups = {}
        for s in pool:
            v = (s.get(key) or "").strip()
            if v:
                groups.setdefault(v, []).append(s)

    eligible = {k: v for k, v in groups.items() if len(v) >= count}
    if not eligible:
        return pool, True

    chosen = rng.choice(sorted(eligible.keys(), key=str))
    return eligible[chosen], False


def _select_songs(date_str, modifier_id, pool):
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
        candidates, fallback = _identity_candidates(date_str, pool, mod["key"], count)
        count = DEFAULT_SONG_COUNT
    else:
        candidates = pool

    rng = random.Random(date_str + ":songs")
    selected = rng.sample(candidates, min(count, len(candidates)))
    return selected, len(selected), fallback


# ── Local library matching ────────────────────────────────────────────────────
def _find_locally(meta_db, song):
    row = meta_db.conn.execute(
        "SELECT filename FROM songs "
        "WHERE title LIKE ? AND artist LIKE ? COLLATE NOCASE LIMIT 1",
        (f"%{song['title']}%", f"%{song['artist']}%"),
    ).fetchone()
    return row[0] if row else None


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
            songs, song_count, fallback = _select_songs(today, modifier_id, pool)
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
        return {
            "date": today,
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
                    "select": "display_name,completed_at,streak",
                },
            )
        except Exception as e:
            return {"date": target, "day_name": day_name, "entries": [], "error": str(e)}

        return {"date": target, "day_name": day_name, "entries": entries}

    @app.post("/api/plugins/the_daily/sign")
    def sign_leaderboard(data: dict):
        display_name = (data.get("display_name") or "").strip()
        if not display_name:
            return {"error": "Name required"}

        if not SUPABASE_URL or SUPABASE_URL.startswith("https://YOURPROJECT"):
            return {"error": "Supabase not configured"}

        today = date.today().isoformat()
        conn = _get_conn()

        row = conn.execute(
            "SELECT song_count FROM daily_setlists WHERE date = ?", (today,)
        ).fetchone()
        if not row:
            return {"error": "No setlist for today"}

        done = conn.execute(
            "SELECT COUNT(*) FROM daily_completions WHERE date = ?", (today,)
        ).fetchone()[0]
        if done < row[0]:
            return {"error": "Setlist not complete yet"}

        streak = _compute_streak(conn, today) + 1
        day_name = conn.execute(
            "SELECT day_name FROM daily_setlists WHERE date = ?", (today,)
        ).fetchone()[0]

        try:
            _supabase_post(
                "/rest/v1/leaderboard",
                {
                    "date": today,
                    "day_name": day_name,
                    "display_name": display_name,
                    "completed_at": datetime.utcnow().isoformat() + "Z",
                    "streak": streak,
                },
            )
        except Exception as e:
            return {"error": f"Could not sign leaderboard: {e}"}

        return {"ok": True, "streak": streak}

"""Unlock cache for The Daily — the shared Host-URL store behind Acquisition.

A song is **Unlocked** the first time anyone Captures its Host URL. This module
is that cache. Two layers:

  - **Local** (SQLite mirror in the_daily.db): source of truth for *reads* —
    instant, offline, and the reason N=1 (solo) already benefits from its own
    Captures across replays / the Archive / a reinstall.
  - **Supabase** (`cdlc_links` table): the share + backup layer, consulted on a
    local miss and written on every Capture/report, so the community benefits
    if it shows up. Same anon read/insert/update trust model as `leaderboard`.

Resolve order (ADR 0011): local -> Supabase -> miss. A miss means the caller
falls back to the Manual Floor (human Capture on CustomsForge).

Trust is **on-first-capture**: any validated PSARC Capture makes a song
silently fetchable. The `sha256` is recorded but NOT gated — kept so
corroboration/quarantine can be switched on later if poisoning becomes real.
The `reported` flag is set when a Host URL yielded a non-PSARC (a Reported
Item): such a song is never silently fetched and its Room is auto-completed.

This module never touches CustomsForge. It only ever stores/returns Host URLs.

Supabase DDL (run once; RLS off or permissive anon select/insert/update, same
as the existing leaderboard/inventory tables):

    create table cdlc_links (
        cf_id      bigint primary key,
        host_url   text not null,
        provider   text,
        filename   text,
        version    text,
        sha256     text,
        reported   boolean not null default false,
        updated_at timestamptz not null default now()
    );
"""

import hashlib
import json
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone

_TABLE = "cdlc_links"


# ── helpers ───────────────────────────────────────────────────────────────

def provider_of(url):
    u = (url or "").lower()
    if "dropbox.com" in u:
        return "dropbox"
    if "drive.google.com" in u or "drive.usercontent.google.com" in u:
        return "gdrive"
    if "onedrive.live.com" in u or "1drv.ms" in u:
        return "onedrive"
    if "mega.nz" in u or "mega.co.nz" in u:
        return "mega"
    if "mediafire.com" in u:
        return "mediafire"
    return "other"


def version_of(filename):
    """Pull a CDLC version tag (e.g. _v2, _v5_5) out of a filename, if present."""
    m = re.search(r'_(v\d+(?:_\d+)?)_', (filename or ""))
    return m.group(1) if m else None


def sha256_of(path):
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
    except OSError:
        return None
    return h.hexdigest()


def _now():
    return datetime.now(timezone.utc).isoformat()


def _sb_configured(sb_url):
    return bool(sb_url) and not sb_url.startswith("https://YOURPROJECT")


def _sb(method, path, sb_url, sb_key, body=None, prefer=None, timeout=10):
    url = sb_url + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("apikey", sb_key)
    req.add_header("Authorization", f"Bearer {sb_key}")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if prefer:
        req.add_header("Prefer", prefer)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if not raw:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            return None


# ── local mirror ──────────────────────────────────────────────────────────

def ensure_local_table(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS unlock_cache (
            cf_id      INTEGER PRIMARY KEY,
            host_url   TEXT NOT NULL,
            provider   TEXT,
            filename   TEXT,
            version    TEXT,
            sha256     TEXT,
            reported   INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT
        )
    """)
    conn.commit()


def _local_get(conn, cf_id):
    row = conn.execute(
        "SELECT cf_id, host_url, provider, filename, version, sha256, reported "
        "FROM unlock_cache WHERE cf_id = ?", (cf_id,)
    ).fetchone()
    if not row:
        return None
    return {"cf_id": row[0], "host_url": row[1], "provider": row[2],
            "filename": row[3], "version": row[4], "sha256": row[5],
            "reported": bool(row[6])}


def _local_put(conn, entry):
    conn.execute(
        "INSERT INTO unlock_cache "
        "(cf_id, host_url, provider, filename, version, sha256, reported, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(cf_id) DO UPDATE SET "
        "host_url=excluded.host_url, provider=excluded.provider, "
        "filename=excluded.filename, version=excluded.version, "
        "sha256=excluded.sha256, reported=excluded.reported, "
        "updated_at=excluded.updated_at",
        (entry["cf_id"], entry["host_url"], entry.get("provider"),
         entry.get("filename"), entry.get("version"), entry.get("sha256"),
         1 if entry.get("reported") else 0, _now()))
    conn.commit()


# ── public API ────────────────────────────────────────────────────────────

def resolve(conn, cf_id, sb_url=None, sb_key=None):
    """Resolve a song to its Unlock state.

    Returns one of:
      {"status": "hit",      "host_url": ..., "provider": ..., ...}  # silently fetchable
      {"status": "reported", "cf_id": ...}                            # Reported Item -> auto-complete Room
      {"status": "miss"}                                              # not Unlocked -> Manual Floor
    """
    ensure_local_table(conn)
    cf_id = int(cf_id)

    local = _local_get(conn, cf_id)
    if local:
        if local["reported"]:
            return {"status": "reported", "cf_id": cf_id}
        return {"status": "hit", **local}

    if _sb_configured(sb_url):
        try:
            rows = _sb("GET",
                       f"/rest/v1/{_TABLE}?cf_id=eq.{cf_id}&select=*&limit=1",
                       sb_url, sb_key)
        except Exception:
            rows = None
        if rows:
            r = rows[0]
            entry = {"cf_id": cf_id, "host_url": r.get("host_url"),
                     "provider": r.get("provider"), "filename": r.get("filename"),
                     "version": r.get("version"), "sha256": r.get("sha256"),
                     "reported": bool(r.get("reported"))}
            _local_put(conn, entry)  # mirror so the next read is offline-fast
            if entry["reported"]:
                return {"status": "reported", "cf_id": cf_id}
            if entry["host_url"]:
                return {"status": "hit", **entry}

    return {"status": "miss"}


def contribute(conn, cf_id, host_url, filename=None, sha256=None,
               sb_url=None, sb_key=None):
    """Record a validated Capture — Unlocks the song for every later player."""
    ensure_local_table(conn)
    cf_id = int(cf_id)
    entry = {"cf_id": cf_id, "host_url": host_url,
             "provider": provider_of(host_url), "filename": filename,
             "version": version_of(filename), "sha256": sha256,
             "reported": False}
    _local_put(conn, entry)

    if _sb_configured(sb_url):
        body = {"cf_id": cf_id, "host_url": host_url,
                "provider": entry["provider"], "filename": filename,
                "version": entry["version"], "sha256": sha256,
                "reported": False, "updated_at": _now()}
        try:
            _sb("POST", f"/rest/v1/{_TABLE}?on_conflict=cf_id", sb_url, sb_key,
                body=body, prefer="resolution=merge-duplicates,return=minimal")
        except Exception:
            pass  # remote is best-effort; the local mirror already holds it
    return entry


def report(conn, cf_id, host_url, reason="non_psarc", sb_url=None, sb_key=None):
    """Flag a song as a Reported Item — its Host URL yielded a non-PSARC.

    Only flags when the offending host_url matches the cached one (a stale/bad
    URL shouldn't poison a song that already has a different good URL)."""
    ensure_local_table(conn)
    cf_id = int(cf_id)

    local = _local_get(conn, cf_id)
    if local and local["host_url"] != host_url:
        return False  # cache already moved on to a different (good) URL

    entry = {"cf_id": cf_id, "host_url": host_url,
             "provider": provider_of(host_url),
             "filename": (local or {}).get("filename"),
             "version": (local or {}).get("version"),
             "sha256": (local or {}).get("sha256"), "reported": True}
    _local_put(conn, entry)

    if _sb_configured(sb_url):
        body = {"cf_id": cf_id, "host_url": host_url,
                "provider": entry["provider"], "reported": True,
                "updated_at": _now()}
        try:
            _sb("POST", f"/rest/v1/{_TABLE}?on_conflict=cf_id", sb_url, sb_key,
                body=body, prefer="resolution=merge-duplicates,return=minimal")
        except Exception:
            pass
    return True

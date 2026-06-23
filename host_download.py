"""Host-URL downloader for The Daily — the legal "Half B" of Acquisition.

Given a **Host URL** (the author's direct file-host link — Dropbox, Google
Drive, OneDrive, Mega, Mediafire — where a CDLC's PSARC actually lives), fetch
the file into the DLC directory. This module NEVER touches CustomsForge: it
takes no `cf_url`, no CF cookie, hits no CF endpoint. The Host URL is obtained
elsewhere, only ever from a human's own click (webview Capture or the Manual
Floor). See plans/adr/0011-legal-song-acquisition-via-webview-capture.md.

Lifted from the retired find_more `streamer-monitor` branch with its CF-scraping
half (cookie + toggle URL + redirect capture + throttle) deliberately left out.

Public entry point: `acquire_from_host_url(host_url, dlc_dir, megadl=True)`,
which returns one of:
  {"status": "ok",          "filename": "..."}          # valid PSARC written
  {"status": "reported",    "reason": "non_psarc", ...}  # archive/non-PSARC; caller marks Reported Item + auto-completes the Room
  {"status": "needs_webview","provider": "...", "url": ...} # OneDrive / Mega w/o megadl; caller drives the webview
  {"status": "failed",      "error": "..."}              # recoverable (dead/quota/stale/network); caller degrades to Manual Floor
"""

import base64
import binascii
import html as html_mod
import http.cookiejar
import json
import os
import re
import subprocess
import time
import urllib.parse
import urllib.request

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

# Extensions we will not trust — a Host URL pointing at any of these is a
# Reported Item, not an Acquisition.
_ARCHIVE_EXTS = (".zip", ".rar", ".7z", ".tar", ".gz", ".001")


def _gdrive_direct(file_id):
    return (f"https://drive.usercontent.google.com/download"
            f"?id={file_id}&export=download&confirm=t")


def _resolve_gdrive_folder(folder_url):
    """Resolve a Drive folder URL to a direct-download URL for the _p.psarc.

    Uses the embeddedfolderview endpoint, which returns static HTML listing
    files (unlike the JS-rendered /drive/folders/ page).
    """
    m = re.search(r'/folders/([^/?#]+)', folder_url)
    if not m:
        return None
    folder_id = m.group(1)
    view_url = (f"https://drive.google.com/embeddedfolderview"
                f"?id={folder_id}#list")
    req = urllib.request.Request(view_url)
    req.add_header("User-Agent", _UA)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            page = resp.read().decode("utf-8", errors="replace")
    except Exception:
        return None

    entries = re.findall(
        r'href="https://drive\.google\.com/file/d/([^"/]+)/view[^"]*"'
        r'[^>]*>.*?<div class="flip-entry-title">([^<]+)</div>',
        page, re.DOTALL
    )
    if not entries:
        ids = re.findall(
            r'href="https://drive\.google\.com/file/d/([^"/]+)/', page)
        if not ids:
            return None
        return _gdrive_direct(ids[0])

    def _score(name):
        n = name.lower()
        if '_p.psarc' in n:
            return 3
        if n.endswith('p.psarc'):
            return 2
        if n.endswith('.psarc'):
            return 1
        return 0

    entries.sort(key=lambda e: _score(e[1]), reverse=True)
    if _score(entries[0][1]) == 0:
        return None
    return _gdrive_direct(entries[0][0])


def _resolve_mediafire_folder(folder_url):
    """Resolve a Mediafire *folder* share link to a single-file page URL.

    A folder link (`mediafire.com/folder/<key>/...`) renders its contents via
    JS, so there's no download button in the static HTML — the existing single
    -file scrape finds nothing and the acquire degrades to Manual. The public
    folder API returns the file list (incl. quickkeys) as static JSON; pick the
    best `.psarc` and hand back its `/file/<quickkey>` page for the normal
    single-file path to scrape.
    """
    m = re.search(r'/folder/([^/?#]+)', folder_url)
    if not m:
        return None
    key = m.group(1)
    api = ("https://www.mediafire.com/api/1.5/folder/get_content.php"
           f"?folder_key={key}&content_type=files&response_format=json")
    req = urllib.request.Request(api)
    req.add_header("User-Agent", _UA)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception:
        return None
    files = (((data or {}).get("response") or {})
             .get("folder_content") or {}).get("files") or []
    if not files:
        return None

    def _score(f):
        n = (f.get("filename") or "").lower()
        if "_p.psarc" in n:
            return 3
        if n.endswith("p.psarc"):
            return 2
        if n.endswith(".psarc"):
            return 1
        return 0

    files.sort(key=_score, reverse=True)
    if _score(files[0]) == 0:
        return None
    qk = files[0].get("quickkey")
    return f"https://www.mediafire.com/file/{qk}" if qk else None


def _make_direct_url(file_url):
    """Convert a file host URL to a direct download URL where possible."""
    # Dropbox: change dl=0 to dl=1, or add dl=1
    if "dropbox.com" in file_url:
        if "dl=0" in file_url:
            return file_url.replace("dl=0", "dl=1")
        if "dl=1" not in file_url:
            sep = "&" if "?" in file_url else "?"
            return file_url + sep + "dl=1"
    # Google Drive: convert to direct download
    if "drive.google.com" in file_url:
        if "/folders/" in file_url:
            resolved = _resolve_gdrive_folder(file_url)
            if resolved:
                return resolved
        m = re.search(r'/file/d/([^/]+)', file_url)
        if m:
            return _gdrive_direct(m.group(1))
        m = re.search(r'[?&]id=([^&]+)', file_url)
        if m:
            return _gdrive_direct(m.group(1))
    # Mediafire: normalise share variants to a single-file page; the real
    # download link is then scraped from that page inside _download_file.
    if "mediafire.com" in file_url:
        low = file_url.lower()
        if "/folder/" in low:
            resolved = _resolve_mediafire_folder(file_url)
            if resolved:
                return resolved
        # app.mediafire.com/<key> is the JS viewer — the key is the file
        # quickkey, so the classic /file/<key> page carries the download button.
        m = re.match(r'https?://app\.mediafire\.com/([A-Za-z0-9]+)', file_url)
        if m:
            return f"https://www.mediafire.com/file/{m.group(1)}"
    return file_url


def _filename_from(resp, fallback_url):
    cd = resp.headers.get("Content-Disposition", "")
    m = re.search(r'filename="?([^";\n]+)', cd)
    if m:
        return m.group(1).strip()
    name = os.path.basename(urllib.parse.urlparse(fallback_url).path)
    if "?" in name:
        name = name.split("?")[0]
    return name


def _download_file(file_url, dlc_dir):
    """Fetch a fast-path provider URL (Dropbox/Drive/Mediafire) to dlc_dir.

    Returns (filename, body_head). Raises on transport errors. The caller
    classifies body_head (PSARC vs archive vs HTML) — this function does not
    decide trust.
    """
    file_url = _make_direct_url(file_url)

    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cj))

    req = urllib.request.Request(file_url)
    req.add_header("User-Agent", _UA)
    resp = opener.open(req, timeout=120)
    body = resp.read()
    content_type = resp.headers.get("Content-Type", "")

    # Google Drive HTML page (folder listing or file viewer)
    if "text/html" in content_type and b"Google Drive" in body[:1000]:
        page = body.decode("utf-8", errors="replace")
        file_id = None
        idx = page.find("_p.psarc")
        if idx > 0:
            chunk = page[max(0, idx - 2000):idx + 200]
            m = re.search(r'data-id="([^"]+)"', chunk)
            if m:
                file_id = m.group(1)
        if not file_id:
            m = re.search(r'/file/d/([^/?#]+)', resp.url)
            if m:
                file_id = m.group(1)
        if not file_id:
            m = re.search(r'/file/d/([^/"]+)', page)
            if m:
                file_id = m.group(1)
        if file_id:
            req3 = urllib.request.Request(_gdrive_direct(file_id))
            req3.add_header("User-Agent", _UA)
            resp = opener.open(req3, timeout=120)
            body = resp.read()
            content_type = resp.headers.get("Content-Type", "")

    # Mediafire serves an HTML page with the real download link
    if "text/html" in content_type and b"mediafire.com" in body[:5000].lower():
        page = body.decode("utf-8", errors="replace")
        direct = None
        m = re.search(
            r'href="(https?://download\d*\.mediafire\.com/[^"]+)"', page)
        if m:
            direct = html_mod.unescape(m.group(1))
        # Newer pages scramble the button href and carry the real URL base64
        # -encoded in `data-scrambled-url` instead. Decode it when the plain
        # href isn't present.
        if not direct:
            m = re.search(r'data-scrambled-url="([^"]+)"', page)
            if m:
                try:
                    dec = base64.b64decode(m.group(1)).decode(
                        "utf-8", errors="replace")
                    if "mediafire.com" in dec and dec.startswith("http"):
                        direct = dec
                except (binascii.Error, ValueError):
                    direct = None
        if direct:
            req3 = urllib.request.Request(direct)
            req3.add_header("User-Agent", _UA)
            resp = opener.open(req3, timeout=120)
            body = resp.read()
            content_type = resp.headers.get("Content-Type", "")

    # Google Drive large-file confirmation interstitial
    if "text/html" in content_type and b"drive.usercontent.google.com" in body:
        page = body.decode("utf-8", errors="replace")
        m = re.search(
            r'href="(https?://drive\.usercontent\.google\.com/download[^"]+)"',
            page)
        if m:
            req2 = urllib.request.Request(html_mod.unescape(m.group(1)))
            req2.add_header("User-Agent", _UA)
            resp = opener.open(req2, timeout=120)
            body = resp.read()

    filename = _filename_from(resp, resp.url)
    return filename, body


def _mega_via_megadl(host_url, dlc_dir):
    """Fallback Mega path — megatools' `megadl` CLI (the back-pocket native dep).

    Primary Mega handling is the webview; this is only used when the caller
    opts in and the binary is present. Returns the same status dicts.
    """
    try:
        result = subprocess.run(
            ["megadl", "--path", str(dlc_dir), "--no-progress",
             "--print-names", "--choose-files", "p.psarc", host_url],
            capture_output=True, text=True, timeout=180)
    except FileNotFoundError:
        return {"status": "needs_webview", "provider": "mega", "url": host_url}
    except subprocess.TimeoutExpired:
        return {"status": "failed", "error": "mega download timed out"}
    if result.returncode != 0:
        err = (result.stderr or "").strip()
        if "already exists" in err:
            m = re.search(r'Local file already exists: (.+)', err)
            fname = os.path.basename(m.group(1)) if m else "file"
            return {"status": "ok", "filename": fname, "skipped": True}
        return {"status": "failed", "error": f"megadl failed: {err}"}
    filename = (result.stdout or "").strip().split("\n")[-1]
    return _verify_written(os.path.join(str(dlc_dir), filename), filename)


def _verify_written(filepath, filename):
    """Confirm an already-written file is a real PSARC, else classify it."""
    try:
        with open(filepath, "rb") as f:
            head = f.read(8)
    except OSError as e:
        return {"status": "failed", "error": f"cannot read written file: {e}"}
    verdict = _classify(filename, head)
    if verdict["status"] != "ok":
        try:
            os.remove(filepath)
        except OSError:
            pass
    return verdict if verdict["status"] != "ok" else \
        {"status": "ok", "filename": filename}


def _classify(filename, head):
    """Decide whether bytes/name are a trustworthy PSARC, a Reported Item, or
    a recoverable failure. The Reported/recoverable split is load-bearing:
    archives are structurally untrustworthy (Report + auto-complete Room),
    HTML is a transient host failure (degrade to Manual Floor)."""
    name = (filename or "").lower()
    if name.endswith(_ARCHIVE_EXTS) or head[:4] == b"PK\x03\x04" \
            or head[:6] == b"Rar!\x1a\x07":
        return {"status": "reported", "reason": "non_psarc",
                "filename": filename}
    if head[:4] == b"PSAR":
        return {"status": "ok", "filename": filename}
    if b"<htm" in head.lower() or head[:5] == b"<!DOC":
        # Quota page / dead link / login wall — the song is legit, just
        # unreachable right now.
        return {"status": "failed", "error": "host returned HTML, not a file"}
    # Unknown binary that isn't a PSARC and isn't a known archive — don't trust.
    return {"status": "reported", "reason": "non_psarc", "filename": filename}


def acquire_from_host_url(host_url, dlc_dir, megadl=False):
    """Acquire a song's PSARC from its Host URL into dlc_dir.

    `megadl=True` enables the megatools fallback for Mega; default is False so
    Mega routes to the webview (the primary path per ADR 0011).
    """
    if not host_url:
        return {"status": "failed", "error": "no host url"}

    low = host_url.lower()

    # OneDrive cannot be fetched headlessly — needs a browser session.
    if "onedrive.live.com" in low or "1drv.ms" in low:
        return {"status": "needs_webview", "provider": "onedrive",
                "url": host_url}

    # Mega: webview by default; opt-in megadl fallback.
    if "mega.nz" in low or "mega.co.nz" in low:
        if megadl:
            return _mega_via_megadl(host_url, dlc_dir)
        return {"status": "needs_webview", "provider": "mega", "url": host_url}

    # Cheap pre-check: a Host URL whose name is plainly an archive is a
    # Reported Item without spending a download.
    path = urllib.parse.urlparse(host_url).path.lower()
    if path.endswith(_ARCHIVE_EXTS):
        return {"status": "reported", "reason": "non_psarc",
                "filename": os.path.basename(path)}

    # Fast-path providers: Dropbox / Google Drive / Mediafire / direct links.
    try:
        filename, body = _download_file(host_url, str(dlc_dir))
    except Exception as e:  # transport/redirect/host errors are recoverable
        return {"status": "failed", "error": str(e)}

    verdict = _classify(filename, body[:8])
    if verdict["status"] != "ok":
        return verdict

    if not filename or not filename.lower().endswith(".psarc"):
        filename = f"cdlc_{int(time.time())}_p.psarc"
    filepath = os.path.join(str(dlc_dir), filename)
    try:
        with open(filepath, "wb") as f:
            f.write(body)
    except OSError as e:
        return {"status": "failed", "error": f"write failed: {e}"}
    return {"status": "ok", "filename": filename}

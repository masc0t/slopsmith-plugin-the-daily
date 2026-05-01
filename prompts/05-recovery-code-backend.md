# Prompt 05 — Recovery code backend

## Goal

Wire the local-side of the recovery-code identity model from ADR-0001. Generate a 4-word recovery code on first launch, persist it in `daily_inventory.recovery_code`, expose endpoints to read it back and to adopt a pasted code.

This prompt is **local-only** — Supabase mirror push/pull lives in prompt 06.

## Read first

- `plans/adr/0001-recovery-code-identity-and-local-primary-mirror.md`
- `routes.py` — find `_ensure_column` block and existing `/api/plugins/the_daily/inventory` style endpoints

## Files allowed to touch

- `routes.py`
- `static/bip39-4word.json` — read-only; do not regenerate

## Spec

### 1. Schema

Add (if not present):

```python
_ensure_column(_conn, "daily_inventory", "recovery_code", "TEXT")
```

In the existing `_ensure_column` block.

### 2. Word list loader

Load `static/bip39-4word.json` once at module import. If the file is missing, log a warning and use a tiny fallback list (10 simple words) so dev environments without the JSON still work — but the production path expects 2048 words.

```python
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
```

### 3. Code generator

```python
def _generate_recovery_code() -> str:
    import secrets
    words = _load_word_list()
    return "-".join(secrets.choice(words) for _ in range(4))
```

Format: `forest-anchor-rapid-mint`. Lowercase, hyphen-separated, exactly 4 words.

### 4. Code accessor

Get-or-generate, called from `/inventory` and from any first-launch path:

```python
def _get_or_create_recovery_code(conn, install_id: str) -> str:
    row = conn.execute(
        "SELECT recovery_code FROM daily_inventory WHERE install_id = ?",
        (install_id,)
    ).fetchone()
    if row and row[0]:
        return row[0]
    code = _generate_recovery_code()
    with _write_lock:
        conn.execute("""
            INSERT INTO daily_inventory (install_id, recovery_code)
            VALUES (?, ?)
            ON CONFLICT(install_id) DO UPDATE SET recovery_code = excluded.recovery_code
            WHERE daily_inventory.recovery_code IS NULL
        """, (install_id, code))
        conn.commit()
    return code
```

If `daily_inventory` has no `install_id` UNIQUE constraint, adapt to the existing pattern in routes.py — match how other inventory writes are done.

### 5. Endpoints

```python
@app.get("/api/plugins/the_daily/recovery-code")
def get_recovery_code(request: Request):
    install_id = request.headers.get("X-Install-Id") or _get_install_id_from_request(request)
    code = _get_or_create_recovery_code(_conn, install_id)
    return {"code": code}

@app.post("/api/plugins/the_daily/recovery-code/adopt")
async def adopt_recovery_code(request: Request):
    body = await request.json()
    new_code = (body.get("code") or "").strip().lower()
    install_id = request.headers.get("X-Install-Id") or _get_install_id_from_request(request)
    if not _is_valid_code_shape(new_code):
        return {"error": "Invalid code format"}
    # Local adopt = overwrite this install's recovery_code.
    # Supabase pull happens in prompt 06; for now this just records the new code.
    with _write_lock:
        _conn.execute(
            "INSERT INTO daily_inventory (install_id, recovery_code) VALUES (?, ?) "
            "ON CONFLICT(install_id) DO UPDATE SET recovery_code = excluded.recovery_code",
            (install_id, new_code)
        )
        _conn.commit()
    return {"code": new_code, "adopted": True}

def _is_valid_code_shape(code: str) -> bool:
    parts = code.split("-")
    if len(parts) != 4:
        return False
    return all(p.isalpha() and 3 <= len(p) <= 8 for p in parts)
```

Match `_get_install_id_from_request` to whatever pattern routes.py already uses. If install_id isn't a header convention, follow the existing lookup.

### 6. Tests

Add `tests/test_recovery_code.py`:

```python
def test_generate_format():
    code = _generate_recovery_code()
    parts = code.split("-")
    assert len(parts) == 4
    assert all(p.islower() and 3 <= len(p) <= 8 for p in parts)

def test_get_or_create_idempotent(tmp_db):
    install_id = "test-install"
    c1 = _get_or_create_recovery_code(tmp_db, install_id)
    c2 = _get_or_create_recovery_code(tmp_db, install_id)
    assert c1 == c2

def test_adopt_endpoint_validates_shape(client):
    r = client.post("/api/plugins/the_daily/recovery-code/adopt", json={"code": "not-a-code"})
    assert r.status_code == 200
    assert r.json().get("error")
```

Adapt `tmp_db` and `client` fixtures to match existing test patterns in `tests/`.

## Verification

```bash
python -c "import ast; ast.parse(open('routes.py', encoding='utf-8').read())"
pytest tests/test_recovery_code.py -v
grep -n "@app.get.*recovery-code" routes.py
grep -n "_generate_recovery_code\|_get_or_create_recovery_code" routes.py
```

## Out of scope

- Supabase push/pull is prompt 06. This prompt only stores the code locally.
- Do not edit `screen.js`, `screen.html`, or static JS — that is prompt 10.
- Do not invent code rotation or expiry. The code is permanent until the user pastes a new one.
- Do not add catch-up grant logic. ADR-0001 / Q11 grill explicitly removed it. If you see `retroactive_granted` plumbing, leave it alone — prompt 09 will remove it.

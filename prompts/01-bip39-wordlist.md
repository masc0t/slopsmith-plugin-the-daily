# Prompt 01 — BIP39 4-word recovery code word list

## Goal

Ship a 2048-word list as a static JSON file so the recovery code generator (prompt 05) can pick 4 words deterministically. 4 words from a 2048-word list = 44 bits of entropy, plenty for the use case described in `plans/adr/0001-recovery-code-identity-and-local-primary-mirror.md`.

## Read first

- `plans/adr/0001-recovery-code-identity-and-local-primary-mirror.md`

## Files allowed to touch

- `static/bip39-4word.json` (new file)

## Spec

Create `static/bip39-4word.json` containing the standard BIP39 English word list — 2048 words, lowercase, 3-8 chars each.

Use the canonical BIP39 English list. The list is publicly available and standardized; you can hard-code the 2048 words directly into the JSON file. No deduplication, no sorting changes — preserve the canonical order.

File shape:

```json
["abandon", "ability", "able", "about", ..., "zone", "zoo"]
```

Pure JSON array of strings, 2048 entries.

If you cannot reproduce the full canonical list from training data, instead generate the file with this minimal Python helper saved as a one-shot script you run and then delete:

```python
# scratch — generate then delete this file
import urllib.request, json
url = "https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039/english.txt"
words = urllib.request.urlopen(url).read().decode().strip().split("\n")
assert len(words) == 2048
with open("static/bip39-4word.json", "w") as f:
    json.dump(words, f)
```

Either approach is fine. The deliverable is the JSON file.

## Verification

```bash
python -c "import json; w = json.load(open('static/bip39-4word.json')); assert len(w) == 2048; assert all(isinstance(x, str) for x in w); assert all(3 <= len(x) <= 8 for x in w); print('OK', len(w), 'words')"
```

Output must include `OK 2048 words`.

## Out of scope

- Do not edit `routes.py`, `screen.js`, `screen.html`, or any other file.
- Do not implement the recovery code generator — that is prompt 05's job.
- Do not write tests for the file itself; verification command above is sufficient.
- Do not commit the scratch generator script.

# The Daily — Deployment Guide

Internal alpha/beta testing in your own Slopsmith install.

## Quick Start

### 1. Install the Plugin

Copy the entire `the_daily` folder into your Slopsmith plugins directory:

```
<slopsmith_install>/plugins/the_daily/
```

The folder should contain:
- `plugin.json`
- `screen.html`
- `screen.js`
- `routes.py`
- `songs_pool.json` (bundled seed pool)
- `static/` folder (if any)

### 2. Enable in Slopsmith

Restart Slopsmith. The "Daily" tab should appear in navigation.

### 3. Verify First Run

1. Click the **Daily** tab
2. You should see:
   - A setlist of 5 songs
   - A modifier name (e.g., "Drop Day", "Decade Night")
   - A day name (e.g., "Daily #10" or "The 1980s")
3. Click any song to play it
4. Complete all 5 songs to unlock the completion view

## What to Expect

### Daily Behavior

- **UTC midnight reset**: New setlist every day at 00:00 UTC
- **Same setlist globally**: Every install sees identical songs/modifier for a given date
- **Pool来源**: First-run uses bundled `songs_pool.json` (35,981 songs). Once network works, fetches from GitHub release.

### Network Requirements

The plugin fetches from:
- `https://github.com/masc0t/slopsmith-plugin-the-daily/releases/download/pool-archive/pool-manifest.json`
- `https://github.com/masc0t/slopsmith-plugin-the-daily/releases/download/pool-archive/modifiers-manifest.json`

If these are unreachable, it falls back to bundled pool gracefully.

### Database

Creates `the_daily.db` in your Slopsmith config directory:
- `daily_setlists` — cached setlists by date
- `daily_completions` — songs you've completed
- `pool_cache` — downloaded pools

## Verification Commands

### Preview Today's Setlist (CLI)

```bash
cd <plugin_folder>
python preview.py --days 1
```

Expected output:
```
Pool: 35,767 songs (stamp: 2026-04-22)
────────────────────────────────────────────────────────────────────────
Day #10  2026-05-01  db29c2  ⬇️ Drop Day  —  Daily #10
  • Artist                Song Title                   2016  Tuning
  ...
```

### Preview Map Mode

```bash
python preview.py --days 1 --map
```

Shows ASCII map with nodes and lanes.

### Run Tests

```bash
# Python tests
python -m unittest discover tests

# Playwright tests
npx playwright test
```

## Troubleshooting

### "Daily" tab doesn't appear

1. Check plugin folder is inside `<slopsmith>/plugins/`
2. Check `plugin.json` is valid JSON
3. Check for errors in Slopsmith console/logs

### Setlist fails to load

1. Check internet access (GitHub releases)
2. Check bundled pool exists: `songs_pool.json` should be ~14MB
3. Check the_daily.db was created

### Songs won't play

The plugin marks songs as complete via `/mark` endpoint. Check:
- Network to Slopsmith backend is working
- No firewall blocking the plugin's HTTP calls

### Modifier feels broken (too many fallbacks)

Run a longer preview to check fallback rate:
```bash
python preview.py --days 90 2>&1 | Select-String "FALLBACK"
```

If >5% fallback, the modifier pool may need more songs in that category.

### Want to force a new setlist for today

```bash
python reset_today.py
```

This clears today's cached setlist. On next load, it regenerates.

## Data Paths

| Data | Location |
|------|----------|
| Plugin | `<slopsmith>/plugins/the_daily/` |
| Database | `<slopsmith_config>/the_daily.db` |
| Logs | Slopsmith main logs |

## Modifiers Reference

48 modifiers active. Notable ones:
- **identity** (artist, album, decade, year) — pick one group
- **filter** (new_blood, throwback, drop_day) — filter pool
- **sequence** (title_chain, palette_swap) — ordered pairs
- **structural** (bookends, rival_camps) — 1st/last same or alternating
- **composite** (discography, time_machine) — multiple rules
- **ordering** (alphabet_soup, counterclockwise) — sorted
- **meta** (dealers_choice, double_trouble) — delegates to other modifier

## Known Limitations

1. **No local song detection** — Uses LIKE match against meta_db
2. **Supabase optional** — Wall of Fame disabled if not configured
3. **UTC only** — Daily resets at UTC midnight, not local time
4. **Deprecation warnings** — Uses `datetime.utcnow()` (will fix in future Python)

## Version

Current: `1.0.0` (from plugin.json)

---

For developer commands (publishing pools, building modifiers), see CLAUDE.md.
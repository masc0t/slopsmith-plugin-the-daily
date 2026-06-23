#!/usr/bin/env python3
"""Compare two Daily snapshot files and report differences."""

import argparse
import json
import sys
from pathlib import Path


def load_snapshot(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        sys.exit(f"Snapshot not found: {path}")
    with open(p) as f:
        return json.load(f)


def compare_snapshots(baseline: dict, current: dict) -> tuple[list[str], int]:
    """Compare two snapshots, return (differences, changed_days)."""
    diffs = []

    # Compare metadata
    meta_base = baseline.get("meta", {})
    meta_curr = current.get("meta", {})
    for key in ["epoch", "pool_size"]:
        if meta_base.get(key) != meta_curr.get(key):
            diffs.append(f"META: {key} changed: {meta_base.get(key)} -> {meta_curr.get(key)}")

    days_base = {d["date"]: d for d in baseline.get("days", [])}
    days_curr = {d["date"]: d for d in current.get("days", [])}

    all_dates = sorted(set(days_base.keys()) | set(days_curr.keys()))
    changed_days = 0

    for date in all_dates:
        if date not in days_base:
            diffs.append(f"NEW DAY: {date} added in current")
            changed_days += 1
            continue
        if date not in days_curr:
            diffs.append(f"REMOVED: {date} missing from current")
            changed_days += 1
            continue

        base = days_base[date]
        curr = days_curr[date]

        changes = []
        for field in ["modifier", "modifier_label", "day_name", "song_count", "fallback"]:
            if base.get(field) != curr.get(field):
                changes.append(f"{field}: {base.get(field)} -> {curr.get(field)}")

        if base.get("seed") != curr.get("seed"):
            changes.append(f"seed: {base.get('seed')} -> {curr.get('seed')}")

        base_ids = base.get("song_ids", [])
        curr_ids = curr.get("song_ids", [])
        if base_ids != curr_ids:
            added = set(curr_ids) - set(base_ids)
            removed = set(base_ids) - set(curr_ids)
            if added:
                changes.append(f"songs added: {len(added)}")
            if removed:
                changes.append(f"songs removed: {len(removed)}")

        if changes:
            day_num = curr.get("day_number", base.get("day_number"))
            diffs.append(f"Day #{day_num} ({date}):")
            for c in changes:
                diffs.append(f"  - {c}")
            changed_days += 1

        # Compare map data if present
        if "map" in base or "map" in curr:
            base_map = base.get("map", {})
            curr_map = curr.get("map", {})
            if base_map != curr_map:
                if not changes:
                    diffs.append(f"Day #{curr.get('day_number')} ({date}):")
                diffs.append(f"  - map changed: shape={base_map.get('shape')} -> {curr_map.get('shape')}")

    return diffs, changed_days


def main():
    p = argparse.ArgumentParser(description="Compare two Daily snapshot files")
    p.add_argument("baseline", help="Baseline snapshot JSON file")
    p.add_argument("current", help="Current snapshot JSON file to compare against baseline")
    p.add_argument("--quiet", "-q", action="store_true", help="Only show summary, not per-day diffs")
    p.add_argument("--fail-on-diff", action="store_true", help="Exit with code 1 if differences found")
    args = p.parse_args()

    baseline = load_snapshot(args.baseline)
    current = load_snapshot(args.current)

    diffs, changed_days = compare_snapshots(baseline, current)

    total_days_base = len(baseline.get("days", []))
    total_days_curr = len(current.get("days", []))

    print(f"Baseline: {args.baseline} ({total_days_base} days)")
    print(f"Current:  {args.current} ({total_days_curr} days)")
    print(f"{'=' * 60}")

    if not diffs:
        print("No differences found.")
        sys.exit(0)

    print(f"Found {changed_days} changed day(s) out of {max(total_days_base, total_days_curr)} total:")
    print()

    if not args.quiet:
        for d in diffs:
            print(d)
        print()

    print(f"Summary: {changed_days} day(s) changed")

    if args.fail_on_diff:
        sys.exit(1)


if __name__ == "__main__":
    main()

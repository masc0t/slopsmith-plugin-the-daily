#!/usr/bin/env python3
"""Simulate N days of token economy and shop spending."""

import argparse
import json
import random
import sys
from dataclasses import dataclass, field
from typing import Optional


CATALOG = {
    "boss_reroll":     {"cost": 8,  "type": "consumable"},
    "lane_reroll":     {"cost": 12, "type": "consumable"},
    "flair_glow":      {"cost": 15, "type": "cosmetic"},
    "theme_papercraft":{"cost": 25, "type": "cosmetic"},
    "skin_neonsprint": {"cost": 20, "type": "cosmetic"},
    "calendar_pastel": {"cost": 10, "type": "cosmetic"},
}

COSMETIC_IDS = sorted(
    [k for k, v in CATALOG.items() if v["type"] == "cosmetic"],
    key=lambda k: CATALOG[k]["cost"]
)


@dataclass
class DayResult:
    day: int
    cleared: int
    earned: int
    spent: int
    balance: int
    bought: str


@dataclass
class Totals:
    days_played: int = 0
    days_completed: int = 0
    tokens_earned: int = 0
    tokens_spent: int = 0
    final_balance: int = 0
    cosmetics_owned: int = 0
    total_cosmetics: int = 0
    days_to_full_catalog: Optional[int] = None


def run_simulation(
    days: int,
    completion_rate: float,
    full_clear_rate: float,
    bank_rate: float,
    shop_strategy: str,
    seed: int,
) -> tuple[list[DayResult], Totals]:
    rng = random.Random(seed)

    balance = 0
    owned_cosmetics: set[str] = set()
    lane_history: list[str] = []
    global_streak = 0
    first_lane_streak_triggered = False
    full_catalog_day = None

    daily: list[DayResult] = []

    for day_num in range(1, days + 1):
        # Determine if user plays and completes
        played = rng.random() < completion_rate
        if not played:
            daily.append(DayResult(day_num, 0, 0, 0, balance, "-"))
            global_streak = 0
            continue

        cleared = 5  # songs cleared on completion
        full_clear = rng.random() < full_clear_rate

        # Tokens: 3 per song + 5 base (per spec: 3 * cleared + 5 + bonuses)
        earned = 3 * cleared + 5
        if full_clear:
            earned += 5

        # Banking: partial grant early, net same at end of day
        banked_today = rng.random() < bank_rate
        if banked_today:
            # Bank grants 2 * cleared early, reconcile subtracts same amount
            # Net tokens unchanged, just timing difference - no effect on total
            pass

        # Lane streak tracking (simplified: assumes user picks a lane each day)
        lane = "standard"
        lane_streak = 1
        for i in range(len(lane_history) - 1, -1, -1):
            if lane_history[i] == lane:
                lane_streak += 1
            else:
                break
        lane_history.append(lane)

        # First lane streak of 3 (once total)
        if not first_lane_streak_triggered and lane_streak >= 3:
            earned += 10
            first_lane_streak_triggered = True

        # Lane streak milestone (every 7)
        if lane_streak >= 7 and lane_streak % 7 == 0:
            earned += 10

        # Global streak milestone (every 7)
        global_streak += 1
        if global_streak % 7 == 0:
            earned += 10

        # Shop spending
        spent = 0
        bought = "-"

        if shop_strategy == "completionist":
            for cid in COSMETIC_IDS:
                if cid in owned_cosmetics:
                    continue
                cost = CATALOG[cid]["cost"]
                if balance + earned - spent >= cost:
                    spent += cost
                    owned_cosmetics.add(cid)
                    bought = cid
        elif shop_strategy == "consumer":
            # Spend surplus on cheapest consumables
            consumables = sorted(
                [k for k, v in CATALOG.items() if v["type"] == "consumable"],
                key=lambda k: CATALOG[k]["cost"]
            )
            available = balance + earned - spent
            for cid in consumables:
                cost = CATALOG[cid]["cost"]
                if available - spent >= cost:
                    spent += cost
                    bought = cid

        new_balance = balance + earned - spent
        daily.append(DayResult(day_num, cleared, earned, spent, new_balance, bought))
        balance = new_balance

        if full_catalog_day is None and len(owned_cosmetics) == len(COSMETIC_IDS):
            full_catalog_day = day_num

    totals = Totals(
        days_played=days,
        days_completed=sum(1 for d in daily if d.cleared > 0),
        tokens_earned=sum(d.earned for d in daily),
        tokens_spent=sum(d.spent for d in daily),
        final_balance=balance,
        cosmetics_owned=len(owned_cosmetics),
        total_cosmetics=len(COSMETIC_IDS),
        days_to_full_catalog=full_catalog_day,
    )

    return daily, totals


def print_human(daily: list[DayResult], totals: Totals, params: dict):
    pct = f"{totals.days_completed / totals.days_played * 100:.0f}%"
    print(f"Simulating {totals.days_played} days @ "
          f"completion={params['completion_rate']} "
          f"full-clear={params['full_clear_rate']} "
          f"bank={params['bank_rate']:.2f} "
          f"strategy={params['shop_strategy']}")
    print()
    print(f"{'Day':>4}  {'Cleared':>7}  {'Earned':>6}  {'Spent':>5}  {'Balance':>7}  {'Bought'}")
    print("-" * 60)
    for d in daily:
        bought = d.bought if d.bought != "-" else "-"
        print(f"{d.day:>4}  {d.cleared:>7}  {d.earned:>6}  {d.spent:>5}  {d.balance:>7}  {bought}")
    print("-" * 60)
    print()
    print("Totals:")
    print(f"  Days played:        {totals.days_played}")
    print(f"  Days completed:     {totals.days_completed} ({pct})")
    print(f"  Tokens earned:      {totals.tokens_earned}")
    print(f"  Tokens spent:       {totals.tokens_spent}")
    print(f"  Final balance:      {totals.final_balance}")
    print(f"  Cosmetics owned:    {totals.cosmetics_owned} / {totals.total_cosmetics}")
    if totals.days_to_full_catalog:
        print(f"  Days to full-cosmetic catalog: {totals.days_to_full_catalog}")
    else:
        print("  Days to full-cosmetic catalog: not reached")
    print()
    print("Tuning notes:")
    if totals.days_to_full_catalog:
        if totals.days_to_full_catalog < 25:
            print(f"  Target ~30 days for full cosmetic catalog. Current: {totals.days_to_full_catalog} days. Catalog priced too cheap, OR earn rate too high.")
        elif totals.days_to_full_catalog > 35:
            print(f"  Target ~30 days for full cosmetic catalog. Current: {totals.days_to_full_catalog} days. Catalog priced too expensive, OR earn rate too low.")
        else:
            print(f"  Target ~30 days for full cosmetic catalog. Current: {totals.days_to_full_catalog} days. Looks good!")


def build_json(daily: list[DayResult], totals: Totals, params: dict) -> dict:
    return {
        "days": params["days"],
        "params": {
            "completion_rate": params["completion_rate"],
            "full_clear_rate": params["full_clear_rate"],
            "bank_rate": params["bank_rate"],
            "shop_strategy": params["shop_strategy"],
            "seed": params["seed"],
        },
        "daily": [
            {
                "day": d.day,
                "cleared": d.cleared,
                "earned": d.earned,
                "spent": d.spent,
                "balance": d.balance,
                "bought": d.bought if d.bought != "-" else None,
            }
            for d in daily
        ],
        "totals": {
            "days_played": totals.days_played,
            "days_completed": totals.days_completed,
            "tokens_earned": totals.tokens_earned,
            "tokens_spent": totals.tokens_spent,
            "final_balance": totals.final_balance,
            "cosmetics_owned": totals.cosmetics_owned,
            "total_cosmetics": totals.total_cosmetics,
            "days_to_full_catalog": totals.days_to_full_catalog,
        },
    }


def main():
    p = argparse.ArgumentParser(description="Simulate token economy")
    p.add_argument("--days", type=int, default=30, metavar="N",
                   help="Number of simulated days (default: 30)")
    p.add_argument("--completion-rate", type=float, default=0.85,
                   help="Probability of clearing boss each day (default: 0.85)")
    p.add_argument("--full-clear-rate", type=float, default=0.4,
                   help="Conditional probability of full-clear given completion (default: 0.4)")
    p.add_argument("--bank-rate", type=float, default=0.0,
                   help="Probability of banking at a rest node (default: 0.0)")
    p.add_argument("--shop-strategy", type=str, default="completionist",
                   choices=["completionist", "consumer"],
                   help="Shop spending strategy (default: completionist)")
    p.add_argument("--seed", type=int, default=42,
                   help="RNG seed for deterministic runs (default: 42)")
    p.add_argument("--json", action="store_true",
                   help="Emit machine-readable JSON output")
    args = p.parse_args()

    params = {
        "days": args.days,
        "completion_rate": args.completion_rate,
        "full_clear_rate": args.full_clear_rate,
        "bank_rate": args.bank_rate,
        "shop_strategy": args.shop_strategy,
        "seed": args.seed,
    }

    daily, totals = run_simulation(
        args.days, args.completion_rate, args.full_clear_rate,
        args.bank_rate, args.shop_strategy, args.seed
    )

    if args.json:
        print(json.dumps(build_json(daily, totals, params), indent=2))
    else:
        print_human(daily, totals, params)


if __name__ == "__main__":
    main()

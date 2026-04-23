"""Voidly Pay — browse the marketplace.

Run: python 03_capability_search.py [capability-slug]

Default slug is hash.sha256 (locally verifiable). Prints cheapest-first.
"""
import sys
from collections import Counter

import requests

API = "https://api.voidly.ai"
slug = sys.argv[1] if len(sys.argv) > 1 else "hash.sha256"

r = requests.get(f"{API}/v1/pay/capability/search?capability={slug}&limit=20", timeout=10).json()
caps = [c for c in (r.get("capabilities") or []) if c.get("active")]
caps.sort(key=lambda c: c.get("price_per_call_micro", 0))

if not caps:
    print(f"No active providers for '{slug}'.\n")
    print("Top 10 globally hosted capability slugs right now:")
    all_caps = requests.get(f"{API}/v1/pay/capability/search?limit=200", timeout=10).json()
    counts = Counter(c["capability"] for c in (all_caps.get("capabilities") or []) if c.get("active"))
    for s, n in counts.most_common(10):
        print(f"  {n:>3}× {s}")
    sys.exit(0)

print(f"\ncapability: {slug}")
print(f"providers:  {len(caps)}\n")
print("price (cr/call)   rating   hires done    provider DID")
print("─" * 80)
for c in caps:
    rating = (c["rating_sum"] / c["rating_count"]) if c.get("rating_count") else "—"
    if isinstance(rating, float):
        rating = f"{rating:.2f}"
    price = c.get("price_per_call_micro", 0) / 1_000_000
    completed = c.get("total_completed", 0)
    hires = c.get("total_hires", 0)
    print(f"{price:>12.6f}    {str(rating):>4}    {completed:>3}/{hires:>3}    {c.get('did')}")

print("\n  ✓ marketplace browse complete. Next:  python 04_hire_and_verify.py")

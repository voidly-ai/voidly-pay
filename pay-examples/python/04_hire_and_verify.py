"""Voidly Pay — hire a live provider and verify their work locally.

Full trust roundtrip: search, hire, wait for work claim, verify the
returned hash matches local compute, accept (releases escrow).

Run: python 04_hire_and_verify.py
"""
import hashlib
import json
import time
from pathlib import Path

import requests
from voidly_pay import VoidlyPay

API = "https://api.voidly.ai"
me = json.loads(Path("pay-examples-key.json").read_text())
pay = VoidlyPay(did=me["did"], secret_base64=me["secretKeyBase64"])

# 1. cheapest hash.sha256
search = requests.get(
    f"{API}/v1/pay/capability/search?capability=hash.sha256&limit=10",
    timeout=10,
).json()
caps = [c for c in (search.get("capabilities") or []) if c.get("active")]
caps.sort(key=lambda c: c.get("price_per_call_micro", 0))
if not caps:
    print("no hash.sha256 providers live right now")
    raise SystemExit(1)
cap = caps[0]
print(f"hiring {cap['did']} @ {cap['price_per_call_micro'] / 1_000_000:.6f} cr for {cap['capability']}")

# 2. pick input + local hash
text = f"hire-and-verify-{int(time.time()*1000)}"
expected = hashlib.sha256(text.encode("utf-8")).hexdigest()
print(f"input text: \"{text}\"")
print(f"expected sha256: {expected}")

# 3. hire + wait — SDK helper does atomic open-escrow + record-hire, polls receipt.
result = pay.hire_and_wait(
    capability_id=cap["id"],
    input={"text": text},
    delivery_deadline_hours=1,
    poll_interval_ms=2000,
    timeout_ms=90_000,
    verify=lambda s: s == expected,
)

hire = getattr(result, "hire", None) or (result.get("hire") if isinstance(result, dict) else None) or {}
receipt = getattr(result, "receipt", None) or (result.get("receipt") if isinstance(result, dict) else None) or {}
accepted = getattr(result, "accepted", None)
if accepted is None and isinstance(result, dict):
    accepted = result.get("accepted")

print(f"\nhire id:    {hire.get('id') if isinstance(hire, dict) else hire}")
print(f"receipt id: {receipt.get('id') if isinstance(receipt, dict) else receipt}")
print(f"provider returned: {receipt.get('summary') if isinstance(receipt, dict) else receipt}")
print(f"accepted:   {accepted}")
verified = bool(accepted) and (receipt.get("summary") if isinstance(receipt, dict) else None) == expected
print(f"verified:   {verified}")

if verified:
    print("\n  ✓ full trust roundtrip complete — escrow auto-released to provider")
else:
    print("\n  ✗ provider returned wrong hash — receipt was auto-disputed")

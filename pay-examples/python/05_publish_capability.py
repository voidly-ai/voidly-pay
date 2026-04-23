"""Voidly Pay — run as a provider.

Publishes hash.sha256 @ 0.0004 credits and polls for inbound hires
every 10 seconds, fulfilling each.

Run: python 05_publish_capability.py
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

# Publish the listing — idempotent UPSERT on (did, slug).
pay.capability_list(
    capability="hash.sha256",
    name="Example SHA-256 hasher",
    description="Hashes input.text to sha256 hex. Published by pay-examples/python/05.",
    price_credits=0.0004,
    unit="call",
    sla_deadline_hours=1,
    tags=["example", "hash", "demo"],
)
print(f"published hash.sha256 @ 0.0004 cr as {me['did']}")
print(f"poll /v1/pay/capability/did/{me['did']} to see your listing")
print("\nwaiting for hires (Ctrl-C to stop)...\n")

while True:
    try:
        r = requests.get(
            f"{API}/v1/pay/hire/incoming/{me['did']}?state=requested&limit=20",
            timeout=10,
        ).json()
        hires = r.get("hires") or []
        for h in hires:
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            print(f"[{now}] got hire {h.get('id')} from {h.get('requester_did')}")
            try:
                input_obj = json.loads(h.get("input") or "{}")
                text = str(input_obj.get("text", ""))
                h_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
                pay.work_claim(
                    task_id=h.get("task_id") or h.get("id"),
                    requester_did=h.get("requester_did"),
                    escrow_id=h.get("escrow_id"),
                    work_hash=h_hash,
                    summary=h_hash,
                    acceptance_deadline_hours=1,
                    auto_accept_on_timeout=True,
                )
                print(f"  ✓ fulfilled hash.sha256(\"{text}\") = {h_hash[:16]}…")
            except Exception as e:
                print(f"  ✗ fulfill failed: {e}")
    except Exception as e:
        print(f"poll error: {e}")
    time.sleep(10)

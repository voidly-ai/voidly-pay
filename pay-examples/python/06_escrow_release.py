"""Voidly Pay — explicit escrow flow (open → release).

Usually `hire()` opens an escrow for you atomically. This script shows
the lower-level flow for custom workflows — bounties, scoping-before-task,
anything where escrow outlives the marketplace primitive.

Run: python 06_escrow_release.py
"""
import json
import time
from pathlib import Path

import requests
from voidly_pay import VoidlyPay, generate_keypair

API = "https://api.voidly.ai"
me = json.loads(Path("pay-examples-key.json").read_text())
pay = VoidlyPay(did=me["did"], secret_base64=me["secretKeyBase64"])

# Throwaway recipient.
kp = generate_keypair()
recipient = {
    "did": kp["did"] if isinstance(kp, dict) else kp.did,
    "publicKeyBase64": kp["public_key_base64"] if isinstance(kp, dict) else kp.public_key_base64,
    "secretKeyBase64": kp["secret_key_base64"] if isinstance(kp, dict) else kp.secret_key_base64,
}
requests.post(
    f"{API}/v1/agent/register",
    json={
        "name": f"pay-example-escrow-recipient-{recipient['did'][-8:]}",
        "signing_public_key": recipient["publicKeyBase64"],
        "encryption_public_key": recipient["publicKeyBase64"],
    },
    timeout=10,
)
print(f"recipient DID: {recipient['did']}")

# Open a 0.5-credit escrow, 1h deadline.
open_result = pay.escrow_open(
    to_did=recipient["did"],
    amount_credits=0.5,
    deadline_hours=1,
)
escrow = open_result.get("escrow") if isinstance(open_result, dict) else open_result
escrow_id = escrow.get("id") if isinstance(escrow, dict) else open_result.get("id")
print(f"escrow opened: {escrow_id}")
print("  state: open, amount: 0.5 cr, deadline: +1h")

e = requests.get(f"{API}/v1/pay/escrow/{escrow_id}", timeout=10).json()
state = e.get("escrow", {}).get("state") or e.get("state")
print(f"  confirmed state: {state}")

time.sleep(1.5)

# Release.
pay.escrow_release(escrow_id=escrow_id)
print(f"escrow released to {recipient['did']}")

e = requests.get(f"{API}/v1/pay/escrow/{escrow_id}", timeout=10).json()
state = e.get("escrow", {}).get("state") or e.get("state")
print(f"  final state: {state}")

rb = requests.get(f"{API}/v1/pay/wallet/{recipient['did']}", timeout=10).json()
bal = (rb.get("wallet", {}).get("balance_micro") or rb.get("balance_micro") or 0) / 1_000_000
print(f"  recipient balance: {bal} cr")

print("\n  ✓ open → release flow complete")
print("    (for open → refund, call pay.escrow_refund instead of escrow_release)")

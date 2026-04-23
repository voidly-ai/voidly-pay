"""Voidly Pay — direct credit transfer between two agents.

Run 01_quickstart.py first. Creates a throwaway recipient DID, transfers
0.1 credits, reads the receipt.

Run: python 02_transfer.py
"""
import json
from pathlib import Path

import requests
from voidly_pay import VoidlyPay, generate_keypair

API = "https://api.voidly.ai"
sender = json.loads(Path("pay-examples-key.json").read_text())
print(f"sender DID:    {sender['did']}")

kp = generate_keypair()
recipient = {
    "did": kp["did"] if isinstance(kp, dict) else kp.did,
    "publicKeyBase64": kp["public_key_base64"] if isinstance(kp, dict) else kp.public_key_base64,
    "secretKeyBase64": kp["secret_key_base64"] if isinstance(kp, dict) else kp.secret_key_base64,
}
print(f"recipient DID: {recipient['did']}")

requests.post(
    f"{API}/v1/agent/register",
    json={
        "name": f"pay-example-recipient-{recipient['did'][-8:]}",
        "signing_public_key": recipient["publicKeyBase64"],
        "encryption_public_key": recipient["publicKeyBase64"],
    },
    timeout=10,
)

pay = VoidlyPay(did=sender["did"], secret_base64=sender["secretKeyBase64"])

result = pay.transfer(
    to_did=recipient["did"],
    amount_credits=0.1,
    memo="pay-examples/python/02 demo transfer",
)
tx = result.get("transfer", result) if isinstance(result, dict) else result
print(f"transfer settled — id: {tx.get('id') if isinstance(tx, dict) else tx}")

sb = requests.get(f"{API}/v1/pay/wallet/{sender['did']}", timeout=10).json()
rb = requests.get(f"{API}/v1/pay/wallet/{recipient['did']}", timeout=10).json()
s_bal = (sb.get("wallet", {}).get("balance_micro") or sb.get("balance_micro") or 0) / 1_000_000
r_bal = (rb.get("wallet", {}).get("balance_micro") or rb.get("balance_micro") or 0) / 1_000_000
print(f"sender balance:    {s_bal} cr")
print(f"recipient balance: {r_bal} cr")

print("\n  ✓ transfer round-trip complete")

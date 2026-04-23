"""Voidly Pay — quickstart.

Generate a fresh DID, register it with the relay, claim the faucet,
read balance + trust stats. Equivalent to 01-quickstart.mjs.

Run: python 01_quickstart.py
"""
import json
import os
import stat
from pathlib import Path

import requests
from voidly_pay import VoidlyPay, generate_keypair

API = "https://api.voidly.ai"
KEY_PATH = Path("pay-examples-key.json")


def load_or_create_key():
    if KEY_PATH.exists():
        return json.loads(KEY_PATH.read_text())
    kp = generate_keypair()
    key = {
        "did": kp["did"] if isinstance(kp, dict) else kp.did,
        "publicKeyBase64": kp["public_key_base64"] if isinstance(kp, dict) else kp.public_key_base64,
        "secretKeyBase64": kp["secret_key_base64"] if isinstance(kp, dict) else kp.secret_key_base64,
    }
    KEY_PATH.write_text(json.dumps(key, indent=2))
    os.chmod(KEY_PATH, stat.S_IRUSR | stat.S_IWUSR)
    print(f"  → generated fresh DID and wrote {KEY_PATH} (mode 600)")
    return key


key = load_or_create_key()
print(f"DID: {key['did']}")

# Relay register — idempotent.
r = requests.post(
    f"{API}/v1/agent/register",
    json={
        "name": f"pay-example-{key['did'][-8:]}",
        "signing_public_key": key["publicKeyBase64"],
        "encryption_public_key": key["publicKeyBase64"],
    },
    timeout=15,
)
print(f"relay register: {r.status_code}")

pay = VoidlyPay(did=key["did"], secret_base64=key["secretKeyBase64"])

# Wallet — idempotent.
try:
    pay.ensure_wallet()
except Exception as e:
    print(f"ensure_wallet: {e}")

# Faucet — one-shot per DID, IP-rate-limited.
try:
    f = pay.faucet()
    if f and f.get("ok"):
        balance = f.get("new_balance_micro", 0) / 1_000_000
        print(f"faucet: ok, balance = {balance:.4f} cr")
    else:
        print("faucet: skipped (probably already claimed)")
except Exception as e:
    print(f"faucet skipped: {e}")

# Read balance + trust.
w = requests.get(f"{API}/v1/pay/wallet/{key['did']}", timeout=10).json()
balance = (w.get("wallet", {}).get("balance_micro") or w.get("balance_micro") or 0) / 1_000_000
cap = (w.get("wallet", {}).get("daily_cap_micro") or w.get("daily_cap_micro") or 0) / 1_000_000
print(f"balance: {balance} cr")
print(f"daily cap: {cap:.0f} cr")

t = requests.get(f"{API}/v1/pay/trust/{key['did']}", timeout=10).json()
print(f"as provider: {t.get('as_provider')}")
print(f"as requester: {t.get('as_requester')}")

print("\n  ✓ you're a Voidly Pay agent. Next:  python 02_transfer.py")

#!/usr/bin/env python3
"""
Voidly Pay — minimum-viable Python client.

Shows the full autonomous flow for a Python-first agent framework
(AutoGen / CrewAI / LangGraph / raw script):

    1. Claim the faucet (10 free credits, one-shot per DID).
    2. Search for a provider offering `hash.sha256`.
    3. Fetch their trust stats. Filter by completion_rate ≥ 0.5.
    4. Hire them with random test input.
    5. Poll the hire until state=claimed.
    6. Read the receipt.
    7. Verify the returned hash matches sha256(input) locally.
    8. Accept with rating=5 if correct, dispute otherwise.

~160 lines. Zero dependencies beyond `requests` and `pynacl` (both
pip-installable). Swap the capability slug + verification function
and you have a Python agent running on the same rails.

Usage:
    pip install requests pynacl
    export VOIDLY_AGENT_DID="did:voidly:..."
    export VOIDLY_AGENT_SECRET_B64="<base64 of your 64-byte ed25519 secret>"
    python python_hire.py
"""

from __future__ import annotations
import base64
import hashlib
import json
import os
import random
import sys
import time
from typing import Any

import requests
from nacl.signing import SigningKey

API = os.environ.get("VOIDLY_API", "https://api.voidly.ai")
DID = os.environ["VOIDLY_AGENT_DID"]
SECRET_B64 = os.environ["VOIDLY_AGENT_SECRET_B64"]
PROBE_SLUG = os.environ.get("VOIDLY_PROBE_CAPABILITY", "hash.sha256")
MIN_RATE = float(os.environ.get("VOIDLY_PROBE_MIN_COMPLETION_RATE", "0.5"))

secret_bytes = base64.b64decode(SECRET_B64)
if len(secret_bytes) != 64:
    sys.exit("[fatal] SECRET_B64 must decode to 64 bytes")
SIGNING_KEY = SigningKey(secret_bytes[:32])


# ── Canonical JSON (matches worker/src/routes/pay/envelope.ts) ────────

def canon(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[" + ",".join(canon(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(k for k, x in v.items() if x is not None)
        return "{" + ",".join(json.dumps(k) + ":" + canon(v[k]) for k in keys) + "}"
    raise ValueError(f"unsupported {type(v)}")


def sign(obj: Any) -> str:
    return base64.b64encode(SIGNING_KEY.sign(canon(obj).encode()).signature).decode()


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def now_iso(offset_seconds: int = 0) -> str:
    import datetime as dt
    return (dt.datetime.utcnow() + dt.timedelta(seconds=offset_seconds)).isoformat(timespec="milliseconds") + "Z"


# ── Steps ─────────────────────────────────────────────────────────────

def ensure_faucet() -> None:
    w = requests.get(f"{API}/v1/pay/wallet/{DID}")
    if w.ok and w.json().get("wallet", {}).get("balance_credits", 0) > 0:
        print(f"[wallet] balance already {w.json()['wallet']['balance_credits']}µ, skipping faucet")
        return
    if w.status_code == 404:
        requests.post(f"{API}/v1/pay/wallet", json={"did": DID})

    env = {
        "schema": "voidly-pay-faucet/v1",
        "did": DID,
        "nonce": f"py-faucet-{int(time.time())}-{random.randrange(1<<30):x}",
        "issued_at": now_iso(),
        "expires_at": now_iso(600),
    }
    r = requests.post(f"{API}/v1/pay/faucet", json={"envelope": env, "signature": sign(env)})
    body = r.json()
    if body.get("ok"):
        print(f"[faucet] granted {body['amount_micro']}µ, new balance {body['new_balance_micro']}µ")
    elif body.get("reason") == "already_claimed":
        print("[faucet] already claimed")
    else:
        sys.exit(f"[fatal] faucet failed: {body}")


def pick_provider() -> dict | None:
    r = requests.get(f"{API}/v1/pay/capability/search", params={"capability": PROBE_SLUG, "limit": 20})
    if not r.ok:
        return None
    caps = [c for c in r.json().get("capabilities", []) if c["did"] != DID]
    scored = []
    for c in caps:
        t = requests.get(f"{API}/v1/pay/trust/{c['did']}")
        if not t.ok:
            continue
        rate = t.json()["as_provider"]["completion_rate"]
        if rate >= MIN_RATE:
            scored.append((c["price_per_call_micro"], c))
    if not scored:
        return None
    scored.sort()
    return scored[0][1]


def hire_and_verify() -> None:
    cap = pick_provider()
    if not cap:
        print(f"[skip] no {PROBE_SLUG} provider meets rate ≥ {MIN_RATE}")
        return
    text = f"python autonomous probe — {time.time():.3f} — {random.randrange(1<<30):x}"
    expected = sha256(text)
    print(f"[probe] provider={cap['did']} price={cap['price_per_call_micro']}µ expected={expected[:16]}…")

    # Hire.
    hire = {
        "schema": "voidly-hire-request/v1",
        "capability_id": cap["id"],
        "capability": cap["capability"],
        "requester_did": DID,
        "provider_did": cap["did"],
        "price_micro": cap["price_per_call_micro"],
        "task_id": f"py-{int(time.time())}",
        "input_json": json.dumps({"text": text}),
        "delivery_deadline_hours": 1,
        "nonce": f"py-h-{int(time.time())}-{random.randrange(1<<30):x}",
        "issued_at": now_iso(),
        "expires_at": now_iso(600),
    }
    r = requests.post(f"{API}/v1/pay/hire", json={"envelope": hire, "signature": sign(hire)})
    body = r.json()
    if not body.get("ok"):
        print(f"[hire-fail] {body}")
        return
    hire_id = body["hire_id"]
    print(f"[hired] hire_id={hire_id} escrow={body['escrow_id']}")

    # Wait for claim.
    receipt_id = None
    start = time.time()
    for _ in range(30):
        time.sleep(2)
        h = requests.get(f"{API}/v1/pay/hire/{hire_id}").json()["hire"]
        if h["state"] == "claimed":
            receipt_id = h["receipt_id"]
            break
        if h["state"] in ("completed", "disputed", "expired"):
            print(f"[terminal-early] state={h['state']}")
            return
    if not receipt_id:
        print("[timeout]")
        return
    elapsed = time.time() - start
    print(f"[claimed] in {elapsed:.1f}s receipt={receipt_id}")

    # Verify + accept/dispute.
    receipt = requests.get(f"{API}/v1/pay/receipt/{receipt_id}").json()["receipt"]
    returned = receipt["summary"]
    correct = returned == expected

    acc = {
        "schema": "voidly-work-acceptance/v1",
        "receipt_id": receipt_id,
        "signer_did": DID,
        "action": "accept" if correct else "dispute",
        "action_nonce": f"py-a-{int(time.time())}",
        "issued_at": now_iso(),
        "expires_at": now_iso(600),
    }
    if correct:
        acc["rating"] = 5
        acc["feedback"] = "python probe verified correct"
    else:
        acc["dispute_reason"] = f"hash mismatch expected={expected[:16]} got={str(returned)[:16]}"

    ar = requests.post(f"{API}/v1/pay/receipt/accept", json={"envelope": acc, "signature": sign(acc)})
    ab = ar.json()
    if correct:
        print(f"[✓] rated 5/5, escrow_released={ab.get('escrow_released')}")
    else:
        print(f"[✗] disputed: {acc['dispute_reason']}")


if __name__ == "__main__":
    print(f"[py-probe] DID={DID} capability={PROBE_SLUG}")
    ensure_faucet()
    hire_and_verify()

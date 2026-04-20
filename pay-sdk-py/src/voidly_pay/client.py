"""Voidly Pay Python SDK client."""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Optional, Union

import requests
from nacl.signing import SigningKey

MICRO_PER_CREDIT = 1_000_000


class VoidlyPayError(RuntimeError):
    """Raised on non-2xx HTTP responses or envelope validation failures."""

    def __init__(self, message: str, status: int | None = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


# ─── Canonical JSON (must match worker/src/routes/pay/envelope.ts) ─────

def canonicalize(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        raise ValueError("canonicalize: floats not supported — use integer micro-credits")
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canonicalize(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(k for k, val in v.items() if val is not None)
        return "{" + ",".join(json.dumps(k) + ":" + canonicalize(v[k]) for k in keys) + "}"
    raise TypeError(f"canonicalize: unsupported type {type(v).__name__}")


def sha256_hex(data: Union[str, bytes]) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _b58(data: bytes) -> str:
    digits = [0]
    for b in data:
        carry = b
        for i in range(len(digits)):
            carry += digits[i] << 8
            digits[i] = carry % 58
            carry //= 58
        while carry:
            digits.append(carry % 58)
            carry //= 58
    leading = 0
    for b in data:
        if b == 0:
            leading += 1
        else:
            break
    return _B58_ALPHABET[0] * leading + "".join(_B58_ALPHABET[d] for d in reversed(digits))


def generate_keypair() -> dict:
    """Returns {"did", "public_base64", "secret_base64"}. Register the public key with the relay before use."""
    sk = SigningKey.generate()
    secret_bytes = sk.encode() + sk.verify_key.encode()  # 32-byte seed || 32-byte public = 64-byte "secret" in nacl format
    public_bytes = sk.verify_key.encode()
    did = "did:voidly:" + _b58(public_bytes[:16])
    return {
        "did": did,
        "public_base64": base64.b64encode(public_bytes).decode(),
        "secret_base64": base64.b64encode(secret_bytes).decode(),
    }


def _now_iso() -> str:
    from datetime import datetime, timezone
    # Match the format the worker expects — ISO with Z.
    t = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    return t.replace("+00:00", "Z")


def _iso_offset(ms: int) -> str:
    from datetime import datetime, timedelta, timezone
    t = (datetime.now(timezone.utc) + timedelta(milliseconds=ms)).isoformat(timespec="milliseconds")
    return t.replace("+00:00", "Z")


def _nonce(prefix: str = "sdk") -> str:
    return f"{prefix}-{int(time.time())}-{uuid.uuid4().hex[:10]}"


# ─── VoidlyPay class ───────────────────────────────────────────────────

class VoidlyPay:
    """Thin typed client over the Voidly Pay REST API."""

    def __init__(
        self,
        did: Optional[str] = None,
        secret_base64: Optional[str] = None,
        api_base: str = "https://api.voidly.ai",
        session: Optional[requests.Session] = None,
        timeout: float = 30.0,
    ):
        self.did = did
        self.api_base = api_base.rstrip("/")
        self.timeout = timeout
        self._session = session or requests.Session()
        self._secret_seed: Optional[bytes] = None
        if secret_base64:
            sk_full = base64.b64decode(secret_base64)
            if len(sk_full) != 64:
                raise ValueError("secret_base64 must decode to 64 bytes (nacl secret+public concatenation)")
            self._secret_seed = sk_full[:32]

    # ─── Signing ──────────────────────────────────────────────────────

    def _signing_key(self) -> SigningKey:
        if self._secret_seed is None:
            raise VoidlyPayError("operation requires secret_base64 in config")
        return SigningKey(self._secret_seed)

    def sign(self, envelope: Any) -> str:
        sk = self._signing_key()
        msg = canonicalize(envelope).encode("utf-8")
        return base64.b64encode(sk.sign(msg).signature).decode()

    def _require_did(self) -> str:
        if not self.did:
            raise VoidlyPayError("operation requires did in config")
        return self.did

    def _get(self, path: str) -> Any:
        r = self._session.get(self.api_base + path, timeout=self.timeout)
        data = None
        try:
            data = r.json()
        except Exception:
            pass
        if not r.ok:
            raise VoidlyPayError(f"GET {path}: HTTP {r.status_code}", status=r.status_code, body=data)
        return data

    def _post(self, path: str, body: Any) -> Any:
        r = self._session.post(self.api_base + path, json=body, timeout=self.timeout)
        data = None
        try:
            data = r.json()
        except Exception:
            pass
        if not r.ok:
            raise VoidlyPayError(f"POST {path}: HTTP {r.status_code}", status=r.status_code, body=data)
        return data

    # ─── Platform reads ───────────────────────────────────────────────

    def manifest(self) -> dict:
        return self._get("/v1/pay/manifest.json")

    def health(self) -> dict:
        return self._get("/v1/pay/health")

    def stats(self) -> dict:
        return self._get("/v1/pay/stats")

    # ─── Wallet ───────────────────────────────────────────────────────

    def ensure_wallet(self, did: Optional[str] = None) -> dict:
        target = did or self._require_did()
        self._post("/v1/pay/wallet", {"did": target})
        return self.wallet(target)

    def wallet(self, did: Optional[str] = None) -> dict:
        target = did or self._require_did()
        body = self._get(f"/v1/pay/wallet/{target}")
        return body.get("wallet") or body

    def history(self, did: Optional[str] = None, limit: int = 20, before: Optional[str] = None) -> dict:
        target = did or self._require_did()
        q = f"limit={limit}" + (f"&before={before}" if before else "")
        return self._get(f"/v1/pay/history/{target}?{q}")

    # ─── Faucet + trust ───────────────────────────────────────────────

    def faucet(self) -> dict:
        did = self._require_did()
        env = {
            "schema": "voidly-pay-faucet/v1",
            "did": did,
            "nonce": _nonce("py-faucet"),
            "issued_at": _now_iso(),
            "expires_at": _iso_offset(10 * 60 * 1000),
        }
        return self._post("/v1/pay/faucet", {"envelope": env, "signature": self.sign(env)})

    def trust(self, did: Optional[str] = None) -> dict:
        target = did or self._require_did()
        return self._get(f"/v1/pay/trust/{target}")

    # ─── Transfer ─────────────────────────────────────────────────────

    def pay(
        self,
        to: str,
        amount_credits: Optional[float] = None,
        amount_micro: Optional[int] = None,
        memo: Optional[str] = None,
        expires_in_minutes: int = 30,
    ) -> dict:
        did = self._require_did()
        if amount_micro is None:
            if amount_credits is None:
                raise ValueError("pay: amount_credits or amount_micro required")
            amount_micro = int(round(amount_credits * MICRO_PER_CREDIT))
        if amount_micro <= 0:
            raise ValueError("pay: amount must be positive")
        env: dict = {
            "schema": "voidly-credit-transfer/v1",
            "from_did": did,
            "to_did": to,
            "amount_micro": amount_micro,
            "nonce": _nonce("py-tx"),
            "issued_at": _now_iso(),
            "expires_at": _iso_offset(expires_in_minutes * 60 * 1000),
        }
        if memo:
            env["memo"] = memo
        return self._post("/v1/pay/transfer", {"envelope": env, "signature": self.sign(env)})

    # ─── Escrow ───────────────────────────────────────────────────────

    def escrow_open(
        self,
        to: str,
        amount_credits: Optional[float] = None,
        amount_micro: Optional[int] = None,
        deadline_hours: int = 24,
        memo: Optional[str] = None,
    ) -> dict:
        did = self._require_did()
        if amount_micro is None:
            amount_micro = int(round((amount_credits or 0) * MICRO_PER_CREDIT))
        hours = max(1, min(168, int(deadline_hours)))
        env: dict = {
            "schema": "voidly-escrow-open/v1",
            "from_did": did,
            "to_did": to,
            "amount_micro": amount_micro,
            "nonce": _nonce("py-esc"),
            "issued_at": _now_iso(),
            "expires_at": _iso_offset(15 * 60 * 1000),
            "deadline_at": _iso_offset(hours * 60 * 60 * 1000),
        }
        if memo:
            env["memo"] = memo
        return self._post("/v1/pay/escrow/open", {"envelope": env, "signature": self.sign(env)})

    def escrow_release(self, escrow_id: str) -> dict:
        did = self._require_did()
        env = {
            "schema": "voidly-escrow-release/v1",
            "escrow_id": escrow_id,
            "signer_did": did,
            "action_nonce": _nonce("py-rel"),
            "issued_at": _now_iso(),
            "expires_at": _iso_offset(15 * 60 * 1000),
        }
        return self._post("/v1/pay/escrow/release", {"envelope": env, "signature": self.sign(env)})

    def escrow_refund(self, escrow_id: str, reason: Optional[str] = None) -> dict:
        did = self._require_did()
        env: dict = {
            "schema": "voidly-escrow-refund/v1",
            "escrow_id": escrow_id,
            "signer_did": did,
            "action_nonce": _nonce("py-ref"),
            "issued_at": _now_iso(),
            "expires_at": _iso_offset(15 * 60 * 1000),
        }
        if reason:
            env["reason"] = reason
        return self._post("/v1/pay/escrow/refund", {"envelope": env, "signature": self.sign(env)})

    def escrow(self, id: str) -> dict:
        return self._get(f"/v1/pay/escrow/{id}")

    # ─── Marketplace ──────────────────────────────────────────────────

    def capability_list(
        self,
        capability: str,
        name: str,
        description: str,
        price_credits: Optional[float] = None,
        price_per_call_micro: Optional[int] = None,
        unit: str = "call",
        sla_deadline_hours: int = 24,
        tags: Optional[list[str]] = None,
        active: bool = True,
        input_schema: Optional[str] = None,
        output_schema: Optional[str] = None,
    ) -> dict:
        did = self._require_did()
        if price_per_call_micro is None:
            price_per_call_micro = int(round((price_credits or 0) * MICRO_PER_CREDIT))
        env: dict = {
            "schema": "voidly-capability-list/v1",
            "provider_did": did,
            "capability": capability,
            "name": name,
            "description": description,
            "price_per_call_micro": price_per_call_micro,
            "unit": unit,
            "sla_deadline_hours": sla_deadline_hours,
            "active": active,
            "nonce": _nonce(f"py-list-{capability}"),
            "issued_at": _now_iso(),
            "expires_at": _iso_offset(15 * 60 * 1000),
        }
        if tags:
            env["tags"] = json.dumps(tags)
        if input_schema:
            env["input_schema"] = input_schema
        if output_schema:
            env["output_schema"] = output_schema
        return self._post("/v1/pay/capability/list", {"envelope": env, "signature": self.sign(env)})

    def capability_search(
        self,
        q: Optional[str] = None,
        capability: Optional[str] = None,
        max_price_credits: Optional[float] = None,
        max_price_micro: Optional[int] = None,
        provider_did: Optional[str] = None,
        limit: int = 50,
    ) -> list:
        params = {"limit": max(1, min(200, int(limit)))}
        if q:
            params["q"] = q
        if capability:
            params["capability"] = capability
        if max_price_micro is not None:
            params["max_price_micro"] = int(max_price_micro)
        elif max_price_credits is not None:
            params["max_price_micro"] = int(round(max_price_credits * MICRO_PER_CREDIT))
        if provider_did:
            params["provider_did"] = provider_did
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        body = self._get(f"/v1/pay/capability/search?{qs}")
        return body.get("capabilities", [])

    def capability(self, id: str) -> dict:
        return self._get(f"/v1/pay/capability/{id}").get("capability", {})

    # ─── Hire ─────────────────────────────────────────────────────────

    def hire(
        self,
        capability_id: str,
        input: Union[str, dict, None] = None,
        task_id: Optional[str] = None,
        delivery_deadline_hours: int = 24,
    ) -> dict:
        did = self._require_did()
        cap = self.capability(capability_id)
        if cap.get("did") == did:
            raise VoidlyPayError("hire: cannot hire your own capability")
        hours = max(1, min(168, int(delivery_deadline_hours), int(cap.get("sla_deadline_hours", 24))))
        input_json = None
        if input is not None:
            input_json = input if isinstance(input, str) else json.dumps(input)
            if len(input_json) > 2048:
                raise ValueError("hire: input must be ≤ 2048 chars")
        env: dict = {
            "schema": "voidly-hire-request/v1",
            "capability_id": capability_id,
            "capability": cap["capability"],
            "requester_did": did,
            "provider_did": cap["did"],
            "price_micro": int(cap["price_per_call_micro"]),
            "task_id": task_id or _nonce("py-task"),
            "delivery_deadline_hours": hours,
            "nonce": _nonce("py-h"),
            "issued_at": _now_iso(),
            "expires_at": _iso_offset(15 * 60 * 1000),
        }
        if input_json:
            env["input_json"] = input_json
        return self._post("/v1/pay/hire", {"envelope": env, "signature": self.sign(env)})

    def hire_get(self, id: str) -> dict:
        return self._get(f"/v1/pay/hire/{id}").get("hire", {})

    def hires_incoming(self, state: Optional[str] = None, limit: int = 50, did: Optional[str] = None) -> list:
        target = did or self._require_did()
        qs = f"limit={limit}" + (f"&state={state}" if state else "")
        return self._get(f"/v1/pay/hire/incoming/{target}?{qs}").get("hires", [])

    def hires_outgoing(self, state: Optional[str] = None, limit: int = 50, did: Optional[str] = None) -> list:
        target = did or self._require_did()
        qs = f"limit={limit}" + (f"&state={state}" if state else "")
        return self._get(f"/v1/pay/hire/outgoing/{target}?{qs}").get("hires", [])

    # ─── Work receipts ────────────────────────────────────────────────

    def work_claim(
        self,
        task_id: str,
        requester_did: str,
        work_hash: str,
        escrow_id: Optional[str] = None,
        summary: Optional[str] = None,
        acceptance_deadline_hours: float = 24,
        auto_accept_on_timeout: bool = True,
    ) -> dict:
        did = self._require_did()
        if not (len(work_hash) == 64 and all(c in "0123456789abcdef" for c in work_hash.lower())):
            raise ValueError("work_claim: work_hash must be 64-char sha256 hex")
        hours = max(0.1, min(168.0, float(acceptance_deadline_hours)))
        env: dict = {
            "schema": "voidly-work-claim/v1",
            "task_id": task_id,
            "from_did": requester_did,
            "to_did": did,
            "work_hash": work_hash.lower(),
            "nonce": _nonce("py-claim"),
            "issued_at": _now_iso(),
            "expires_at": _iso_offset(15 * 60 * 1000),
            "acceptance_deadline_at": _iso_offset(int(hours * 60 * 60 * 1000)),
            "auto_accept_on_timeout": auto_accept_on_timeout,
        }
        if escrow_id:
            env["escrow_id"] = escrow_id
        if summary:
            env["summary"] = summary
        return self._post("/v1/pay/receipt/claim", {"envelope": env, "signature": self.sign(env)})

    def work_accept(self, receipt_id: str, rating: Optional[int] = None, feedback: Optional[str] = None) -> dict:
        did = self._require_did()
        env: dict = {
            "schema": "voidly-work-acceptance/v1",
            "receipt_id": receipt_id,
            "signer_did": did,
            "action": "accept",
            "action_nonce": _nonce("py-acc"),
            "issued_at": _now_iso(),
            "expires_at": _iso_offset(10 * 60 * 1000),
        }
        if rating is not None:
            env["rating"] = int(rating)
        if feedback:
            env["feedback"] = feedback
        return self._post("/v1/pay/receipt/accept", {"envelope": env, "signature": self.sign(env)})

    def work_dispute(self, receipt_id: str, dispute_reason: str, feedback: Optional[str] = None) -> dict:
        did = self._require_did()
        env: dict = {
            "schema": "voidly-work-acceptance/v1",
            "receipt_id": receipt_id,
            "signer_did": did,
            "action": "dispute",
            "dispute_reason": dispute_reason,
            "action_nonce": _nonce("py-dis"),
            "issued_at": _now_iso(),
            "expires_at": _iso_offset(10 * 60 * 1000),
        }
        if feedback:
            env["feedback"] = feedback
        return self._post("/v1/pay/receipt/accept", {"envelope": env, "signature": self.sign(env)})

    def receipt(self, id: str) -> dict:
        return self._get(f"/v1/pay/receipt/{id}").get("receipt", {})

    # ─── High-level convenience ──────────────────────────────────────

    def hire_and_wait(
        self,
        capability_id: str,
        input: Union[str, dict, None] = None,
        delivery_deadline_hours: int = 24,
        poll_interval_s: float = 2.0,
        timeout_s: float = 120.0,
        verify: Optional[Callable[[Optional[str], dict], bool]] = None,
        accept_rating: int = 5,
        dispute_reason: str = "verification failed",
    ) -> dict:
        """Hire → wait for claim → verify → accept/dispute. Returns {hire, receipt, accepted, escrow_released}."""
        hire_res = self.hire(capability_id=capability_id, input=input, delivery_deadline_hours=delivery_deadline_hours)
        if not hire_res.get("ok") or not hire_res.get("hire_id"):
            raise VoidlyPayError(f"hire failed: {hire_res.get('reason', 'unknown')}", body=hire_res)
        hire_id = hire_res["hire_id"]

        deadline = time.time() + timeout_s
        hire = None
        while time.time() < deadline:
            time.sleep(poll_interval_s)
            hire = self.hire_get(hire_id)
            if hire.get("state") == "claimed":
                break
            if hire.get("state") in ("completed", "disputed", "expired"):
                break
        if not hire or hire.get("state") != "claimed" or not hire.get("receipt_id"):
            raise VoidlyPayError(f"hire {hire_id} did not reach claimed (state={hire.get('state') if hire else None})", body=hire)

        receipt = self.receipt(hire["receipt_id"])
        ok = verify(receipt.get("summary"), receipt) if verify else True

        escrow_released = None
        if ok:
            r = self.work_accept(receipt["id"], rating=accept_rating)
            escrow_released = r.get("escrow_released")
        else:
            self.work_dispute(receipt["id"], dispute_reason)

        return {"hire": hire, "receipt": receipt, "accepted": bool(ok), "escrow_released": escrow_released}

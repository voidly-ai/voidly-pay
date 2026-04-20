"""Unit tests for voidly-pay SDK (no live network needed)."""

from __future__ import annotations
import base64
import pytest
from unittest.mock import MagicMock

from voidly_pay import VoidlyPay, canonicalize, sha256_hex, generate_keypair, MICRO_PER_CREDIT, VoidlyPayError


def test_canonicalize_sorts_keys():
    assert canonicalize({"b": 1, "a": 2}) == '{"a":2,"b":1}'


def test_canonicalize_omits_null_and_none():
    assert canonicalize({"a": 1, "b": None, "c": 2}) == '{"a":1,"c":2}'


def test_canonicalize_rejects_floats():
    with pytest.raises(ValueError):
        canonicalize({"x": 1.5})


def test_canonicalize_nested():
    got = canonicalize({"a": {"c": 2, "b": 1}, "arr": [{"y": 1, "x": 0}]})
    assert got == '{"a":{"b":1,"c":2},"arr":[{"x":0,"y":1}]}'


def test_sha256_empty():
    assert sha256_hex("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def test_generate_keypair_shape():
    kp = generate_keypair()
    assert kp["did"].startswith("did:voidly:")
    assert len(base64.b64decode(kp["public_base64"])) == 32
    assert len(base64.b64decode(kp["secret_base64"])) == 64


def test_sign_requires_secret():
    pay = VoidlyPay(did="did:voidly:test")
    with pytest.raises(VoidlyPayError):
        pay.sign({"x": 1})


def test_requires_did():
    pay = VoidlyPay()
    with pytest.raises(VoidlyPayError):
        pay.faucet()


def test_sign_roundtrip():
    """Signing + verifying with pynacl."""
    kp = generate_keypair()
    pay = VoidlyPay(did=kp["did"], secret_base64=kp["secret_base64"])
    env = {"schema": "voidly-pay-faucet/v1", "did": kp["did"], "nonce": "n", "issued_at": "t", "expires_at": "t2"}
    sig = pay.sign(env)
    # Verify:
    from nacl.signing import VerifyKey
    pub = VerifyKey(base64.b64decode(kp["public_base64"]))
    pub.verify(canonicalize(env).encode(), base64.b64decode(sig))  # raises on bad sig


def test_micro_per_credit():
    assert MICRO_PER_CREDIT == 1_000_000


def test_pay_builds_right_envelope(monkeypatch):
    kp = generate_keypair()
    pay = VoidlyPay(did=kp["did"], secret_base64=kp["secret_base64"])
    captured = {}

    def fake_post(path, body):
        captured["path"] = path
        captured["body"] = body
        return {"schema": "voidly-pay-receipt/v1", "status": "settled", "transfer_id": "t", "envelope_hash": "h"}

    pay._post = fake_post  # type: ignore
    res = pay.pay(to="did:voidly:bob", amount_credits=0.5, memo="test")
    assert res["status"] == "settled"
    assert captured["path"] == "/v1/pay/transfer"
    env = captured["body"]["envelope"]
    assert env["schema"] == "voidly-credit-transfer/v1"
    assert env["amount_micro"] == 500_000
    assert env["from_did"] == kp["did"]
    assert env["to_did"] == "did:voidly:bob"
    assert env["memo"] == "test"


def test_pay_rejects_non_positive():
    kp = generate_keypair()
    pay = VoidlyPay(did=kp["did"], secret_base64=kp["secret_base64"])
    with pytest.raises(ValueError):
        pay.pay(to="did:voidly:bob", amount_micro=0)


def test_capability_list_builds_envelope(monkeypatch):
    kp = generate_keypair()
    pay = VoidlyPay(did=kp["did"], secret_base64=kp["secret_base64"])
    captured = {}

    def fake_post(path, body):
        captured["path"] = path
        captured["body"] = body
        return {"ok": True, "capability_id": "c", "created": True}

    pay._post = fake_post  # type: ignore
    res = pay.capability_list(
        capability="translate",
        name="Translate",
        description="en <-> ja",
        price_credits=0.1,
        tags=["nlp"],
    )
    assert res["ok"]
    env = captured["body"]["envelope"]
    assert env["price_per_call_micro"] == 100_000
    assert env["active"] is True
    assert env["tags"] == '["nlp"]'

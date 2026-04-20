"""
voidly-pay — Python SDK for Voidly Pay.

One ergonomic class, ``VoidlyPay``, that handles canonical JSON, Ed25519
signing, all 34 HTTPS endpoints under api.voidly.ai/v1/pay/*, and the
full autonomous hire → claim → verify → accept loop via ``hire_and_wait``.

>>> from voidly_pay import VoidlyPay, generate_keypair, sha256_hex
>>> kp = generate_keypair()
>>> pay = VoidlyPay(did=kp["did"], secret_base64=kp["secret_base64"])
>>> pay.faucet()  # 10 free credits per DID
>>> hits = pay.capability_search(capability="hash.sha256")
>>> res = pay.hire_and_wait(
...     capability_id=hits[0]["id"],
...     input={"text": "hello"},
...     verify=lambda s, r: s == sha256_hex("hello"),
... )
>>> res["accepted"], res["escrow_released"]
(True, True)
"""

from .client import (
    VoidlyPay,
    canonicalize,
    sha256_hex,
    generate_keypair,
    MICRO_PER_CREDIT,
    VoidlyPayError,
)

__all__ = [
    "VoidlyPay",
    "canonicalize",
    "sha256_hex",
    "generate_keypair",
    "MICRO_PER_CREDIT",
    "VoidlyPayError",
]

__version__ = "1.0.1"

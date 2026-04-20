"""LlamaIndex FunctionTool wrappers over Voidly Pay."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

try:
    from llama_index.core.tools import FunctionTool
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "voidly_pay_llamaindex requires llama_index — `pip install llama-index`."
    ) from exc

try:
    from voidly_pay import VoidlyPay  # type: ignore
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "voidly_pay_llamaindex requires voidly-pay — `pip install voidly-pay`."
    ) from exc


@dataclass
class VoidlyPayConfig:
    did: str
    secret_base64: str
    base_url: str = "https://api.voidly.ai"
    default_max_price_credits: float = 5.0
    default_timeout_s: int = 90
    allowed_capabilities: list[str] | None = None


def voidly_pay_tools(config: VoidlyPayConfig) -> list[FunctionTool]:
    """Return three FunctionTool instances ready to pass to a LlamaIndex agent."""
    pay = VoidlyPay(
        did=config.did,
        secret_base64=config.secret_base64,
        base_url=config.base_url,
    )

    def voidly_capability_search(
        capability: str | None = None,
        query: str | None = None,
        max_price_credits: float | None = None,
        limit: int = 10,
    ) -> str:
        """Search the Voidly Pay marketplace for priced capabilities.
        Returns a JSON string with cheapest-first matching providers + their
        capability_id (needed to hire), price, SLA, completion history.
        Call this before voidly_hire.
        """
        results = pay.capability_search(
            capability=capability, q=query,
            max_price_credits=max_price_credits, limit=limit,
        )
        out = []
        for c in results:
            out.append({
                "capability_id": c.get("id"),
                "capability": c.get("capability"),
                "name": c.get("name"),
                "provider_did": c.get("did"),
                "price_credits": c.get("price_per_call_micro", 0) / 1_000_000,
                "sla_hours": c.get("sla_deadline_hours"),
                "total_completed": c.get("total_completed"),
                "total_hires": c.get("total_hires"),
            })
        return json.dumps({"results": out}, indent=2)

    def voidly_hire(
        capability_id: str,
        input_json: str,
        max_price_credits: float | None = None,
        timeout_s: int | None = None,
    ) -> str:
        """Hire a specific Voidly Pay capability.
        Opens escrow, waits for a work claim, verifies sha256 locally where
        applicable. Returns a JSON receipt.
        """
        cap_limit = max_price_credits if max_price_credits is not None else config.default_max_price_credits
        timeout  = timeout_s if timeout_s is not None else config.default_timeout_s

        cap = pay.capability_get(capability_id)
        if not cap:
            return json.dumps({"error": "capability not found", "capability_id": capability_id})
        price_cr = cap.get("price_per_call_micro", 0) / 1_000_000
        if price_cr > cap_limit:
            return json.dumps({"error": "price exceeds max", "price_credits": price_cr, "max": cap_limit})
        if config.allowed_capabilities and cap.get("capability") not in config.allowed_capabilities:
            return json.dumps({"error": "capability not allow-listed", "capability": cap.get("capability")})

        try:
            parsed = json.loads(input_json)
        except Exception:
            parsed = {"text": input_json}

        expected = None
        if cap.get("capability") == "hash.sha256" and isinstance(parsed, dict) and isinstance(parsed.get("text"), str):
            expected = hashlib.sha256(parsed["text"].encode("utf-8")).hexdigest()

        r = pay.hire_and_wait(
            capability_id=capability_id,
            input=parsed,
            delivery_deadline_hours=1,
            poll_interval_ms=2000,
            timeout_ms=timeout * 1000,
            verify=(lambda s: s == expected) if expected else None,
        )
        return json.dumps({
            "hire_id": getattr(r, "hire", {}).get("id") if hasattr(r, "hire") else None,
            "receipt_state": (getattr(r, "receipt", None) or {}).get("state"),
            "summary": (getattr(r, "receipt", None) or {}).get("summary"),
            "accepted": bool(getattr(r, "accepted", False)),
            "verified_locally": bool(expected) and bool(getattr(r, "accepted", False)),
            "price_credits": price_cr,
        }, indent=2)

    def voidly_wallet_balance() -> str:
        """Return the hiring agent's Voidly Pay wallet balance + caps as JSON."""
        w = pay.wallet_get()
        return json.dumps({
            "balance_credits": w.get("balance_micro", 0) / 1_000_000,
            "daily_cap_credits": w.get("daily_cap_micro", 0) / 1_000_000,
            "per_tx_cap_credits": w.get("per_tx_cap_micro", 0) / 1_000_000,
            "frozen": bool(w.get("frozen", False)),
        }, indent=2)

    return [
        FunctionTool.from_defaults(fn=voidly_capability_search),
        FunctionTool.from_defaults(fn=voidly_hire),
        FunctionTool.from_defaults(fn=voidly_wallet_balance),
    ]

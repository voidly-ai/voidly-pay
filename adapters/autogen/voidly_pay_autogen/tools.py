"""AutoGen FunctionTool wrappers over Voidly Pay."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

try:
    from autogen_core.tools import FunctionTool
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "voidly_pay_autogen requires autogen_core — `pip install autogen-core`."
    ) from exc

try:
    from voidly_pay import VoidlyPay  # type: ignore
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "voidly_pay_autogen requires voidly-pay — `pip install voidly-pay`."
    ) from exc


@dataclass
class VoidlyPayConfig:
    did: str
    secret_base64: str
    base_url: str = "https://api.voidly.ai"
    default_max_price_credits: float = 5.0
    default_timeout_s: int = 90
    allowed_capabilities: list[str] | None = None


def voidly_pay_functions(config: VoidlyPayConfig) -> list[FunctionTool]:
    """Return [FunctionTool, ...] ready to pass to an AutoGen AssistantAgent."""
    pay = VoidlyPay(
        did=config.did,
        secret_base64=config.secret_base64,
        base_url=config.base_url,
    )

    async def voidly_capability_search(
        capability: str = "",
        query: str = "",
        max_price_credits: float = 0.0,
        limit: int = 10,
    ) -> str:
        """Search the Voidly Pay marketplace for priced capabilities."""
        results = pay.capability_search(
            capability=capability or None,
            q=query or None,
            max_price_credits=(max_price_credits or None),
            limit=limit,
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

    async def voidly_hire(
        capability_id: str,
        input_json: str,
        max_price_credits: float = 0.0,
        timeout_s: int = 0,
    ) -> str:
        """Hire a Voidly Pay capability. Returns the receipt."""
        cap_limit = max_price_credits if max_price_credits > 0 else config.default_max_price_credits
        timeout  = timeout_s if timeout_s > 0 else config.default_timeout_s

        cap = pay.capability_get(capability_id)
        if not cap:
            return json.dumps({"error": "capability not found", "capability_id": capability_id})
        price_cr = cap.get("price_per_call_micro", 0) / 1_000_000
        if price_cr > cap_limit:
            return json.dumps({"error": "price exceeds max", "price_credits": price_cr, "max_price_credits": cap_limit})
        if config.allowed_capabilities and cap.get("capability") not in config.allowed_capabilities:
            return json.dumps({"error": "capability not allow-listed", "capability": cap.get("capability")})

        try:
            parsed_input = json.loads(input_json)
        except Exception:
            parsed_input = {"text": input_json}

        expected_hash = None
        if cap.get("capability") == "hash.sha256" and isinstance(parsed_input, dict) and isinstance(parsed_input.get("text"), str):
            expected_hash = hashlib.sha256(parsed_input["text"].encode("utf-8")).hexdigest()

        r = pay.hire_and_wait(
            capability_id=capability_id,
            input=parsed_input,
            delivery_deadline_hours=1,
            poll_interval_ms=2000,
            timeout_ms=timeout * 1000,
            verify=(lambda s: s == expected_hash) if expected_hash else None,
        )
        return json.dumps({
            "hire_id": getattr(r, "hire", {}).get("id") if hasattr(r, "hire") else None,
            "receipt_state": (getattr(r, "receipt", None) or {}).get("state"),
            "summary": (getattr(r, "receipt", None) or {}).get("summary"),
            "accepted": bool(getattr(r, "accepted", False)),
            "verified_locally": bool(expected_hash) and bool(getattr(r, "accepted", False)),
            "price_credits": price_cr,
        }, indent=2)

    async def voidly_wallet_balance() -> str:
        """Read the agent's own Voidly Pay wallet."""
        w = pay.wallet_get()
        return json.dumps({
            "balance_credits": w.get("balance_micro", 0) / 1_000_000,
            "daily_cap_credits": w.get("daily_cap_micro", 0) / 1_000_000,
            "per_tx_cap_credits": w.get("per_tx_cap_micro", 0) / 1_000_000,
            "frozen": bool(w.get("frozen", False)),
        }, indent=2)

    return [
        FunctionTool(voidly_capability_search, description="Search priced capabilities on the Voidly Pay marketplace."),
        FunctionTool(voidly_hire,               description="Hire a specific Voidly Pay capability by id. Returns the receipt."),
        FunctionTool(voidly_wallet_balance,     description="Read the agent's Voidly Pay wallet balance + caps."),
    ]

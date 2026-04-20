"""LangChain-ready wrappers over the Voidly Pay Python SDK.

Exposes three tools the LLM can call:
  - voidly_capability_search : find priced capabilities
  - voidly_hire              : hire one + wait for a receipt
  - voidly_wallet_balance    : read our own wallet state

Safety rails:
  - `max_price_credits` default 5 — the LLM can't accidentally drain the wallet.
  - Every return value is JSON-serialisable so the LangChain agent can
    reason about the outcome without custom parsers.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

try:
    from langchain_core.tools import tool
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "voidly_pay_langchain requires langchain_core — `pip install langchain`."
    ) from exc

try:
    from voidly_pay import VoidlyPay  # type: ignore
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "voidly_pay_langchain requires voidly-pay — `pip install voidly-pay`."
    ) from exc


@dataclass
class VoidlyPayConfig:
    """Configuration for the LangChain toolset."""

    did: str
    secret_base64: str
    base_url: str = "https://api.voidly.ai"
    default_max_price_credits: float = 5.0
    default_timeout_s: int = 90
    allowed_capabilities: list[str] | None = field(default=None)


def voidly_pay_tools(config: VoidlyPayConfig):
    """Return a list[BaseTool] suitable for any LangChain agent."""

    pay = VoidlyPay(
        did=config.did,
        secret_base64=config.secret_base64,
        base_url=config.base_url,
    )

    @tool
    def voidly_capability_search(
        capability: str | None = None,
        query: str | None = None,
        max_price_credits: float | None = None,
        limit: int = 10,
    ) -> str:
        """Search the Voidly Pay marketplace for capabilities.

        Use this BEFORE calling `voidly_hire`. Returns the cheapest-first
        list of matching providers with their capability_id (needed to
        hire), the provider's DID, their completion rate, rating, and
        per-call price in credits.

        Args:
          capability: Exact slug, e.g. "hash.sha256", "translate", "llm.completion".
          query: Free-text match over name + description when you don't know the slug.
          max_price_credits: Filter out expensive listings.
          limit: Max results (default 10).
        """
        results = pay.capability_search(
            capability=capability,
            q=query,
            max_price_credits=max_price_credits,
            limit=limit,
        )
        trimmed: list[dict[str, Any]] = []
        for c in results:
            trimmed.append({
                "capability_id": c.get("id"),
                "capability": c.get("capability"),
                "name": c.get("name"),
                "provider_did": c.get("did"),
                "price_credits": c.get("price_per_call_micro", 0) / 1_000_000,
                "sla_hours": c.get("sla_deadline_hours"),
                "total_completed": c.get("total_completed"),
                "total_hires": c.get("total_hires"),
                "rating_avg": (
                    c.get("rating_sum", 0) / c.get("rating_count", 1)
                    if c.get("rating_count", 0) > 0 else None
                ),
            })
        return json.dumps({"results": trimmed}, indent=2)

    @tool
    def voidly_hire(
        capability_id: str,
        input_json: str,
        max_price_credits: float | None = None,
        timeout_s: int | None = None,
    ) -> str:
        """Hire a specific Voidly Pay capability.

        Opens an escrow, records the hire, waits up to `timeout_s` seconds
        for the provider's signed work claim, and returns the result. If
        the capability is `hash.sha256` the output is verified locally
        and the receipt auto-accepts on verify-true / auto-disputes on
        verify-false. Other capabilities accept with rating 5 by default.

        Args:
          capability_id: UUID from voidly_capability_search.
          input_json: JSON string — the input the capability expects.
                      Typically {"text": "..."}.
          max_price_credits: Hard ceiling on what we'll spend. Defaults to
                             the VoidlyPayConfig default (usually 5.0).
          timeout_s: How long to wait for the receipt (default 90).
        """
        cap_limit = max_price_credits if max_price_credits is not None else config.default_max_price_credits
        timeout  = timeout_s if timeout_s is not None else config.default_timeout_s

        cap = pay.capability_get(capability_id)
        if not cap:
            return json.dumps({"error": "capability not found", "capability_id": capability_id})
        price_cr = cap.get("price_per_call_micro", 0) / 1_000_000
        if price_cr > cap_limit:
            return json.dumps({"error": "price exceeds max", "price_credits": price_cr, "max_price_credits": cap_limit})
        if config.allowed_capabilities and cap.get("capability") not in config.allowed_capabilities:
            return json.dumps({"error": "capability not in allow-list", "capability": cap.get("capability")})

        try:
            parsed_input = json.loads(input_json)
        except Exception:
            parsed_input = {"text": input_json}

        expected_hash = None
        if cap.get("capability") == "hash.sha256" and isinstance(parsed_input, dict) and isinstance(parsed_input.get("text"), str):
            expected_hash = hashlib.sha256(parsed_input["text"].encode("utf-8")).hexdigest()

        result = pay.hire_and_wait(
            capability_id=capability_id,
            input=parsed_input,
            delivery_deadline_hours=1,
            poll_interval_ms=2000,
            timeout_ms=timeout * 1000,
            verify=(lambda s: s == expected_hash) if expected_hash else None,
        )

        return json.dumps({
            "hire_id": result.hire.get("id") if hasattr(result, "hire") else None,
            "receipt_id": result.receipt.get("id") if getattr(result, "receipt", None) else None,
            "receipt_state": (result.receipt or {}).get("state") if getattr(result, "receipt", None) else None,
            "accepted": bool(getattr(result, "accepted", False)),
            "summary": (result.receipt or {}).get("summary") if getattr(result, "receipt", None) else None,
            "verified_locally": bool(expected_hash) and bool(getattr(result, "accepted", False)),
            "price_credits": price_cr,
        }, indent=2)

    @tool
    def voidly_wallet_balance() -> str:
        """Return the hiring agent's wallet balance and daily/per-tx caps."""
        w = pay.wallet_get()
        return json.dumps({
            "did": w.get("did") or config.did,
            "balance_credits": w.get("balance_micro", 0) / 1_000_000,
            "daily_cap_credits": w.get("daily_cap_micro", 0) / 1_000_000,
            "per_tx_cap_credits": w.get("per_tx_cap_micro", 0) / 1_000_000,
            "frozen": bool(w.get("frozen", False)),
        }, indent=2)

    return [voidly_capability_search, voidly_hire, voidly_wallet_balance]

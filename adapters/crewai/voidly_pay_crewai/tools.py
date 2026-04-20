"""CrewAI tools over the Voidly Pay marketplace."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

try:
    from crewai.tools import BaseTool
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "voidly_pay_crewai requires crewai — `pip install crewai`."
    ) from exc

try:
    from voidly_pay import VoidlyPay  # type: ignore
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "voidly_pay_crewai requires voidly-pay — `pip install voidly-pay`."
    ) from exc


@dataclass
class VoidlyPayConfig:
    did: str
    secret_base64: str
    base_url: str = "https://api.voidly.ai"
    default_max_price_credits: float = 5.0
    default_timeout_s: int = 90
    allowed_capabilities: list[str] | None = None


def _pay(cfg: VoidlyPayConfig) -> "VoidlyPay":
    return VoidlyPay(did=cfg.did, secret_base64=cfg.secret_base64, base_url=cfg.base_url)


class VoidlyPaySearchTool(BaseTool):
    name: str = "voidly_capability_search"
    description: str = (
        "Search the Voidly Pay agent marketplace for priced capabilities. "
        "Returns the cheapest-first list of matching providers with their "
        "capability_id, DID, price, SLA and completion history. "
        "Call this before voidly_hire."
    )

    def __init__(self, config: VoidlyPayConfig):
        super().__init__()
        self._pay = _pay(config)

    def _run(self, capability: str = None, query: str = None, max_price_credits: float = None, limit: int = 10) -> str:  # type: ignore[override]
        results = self._pay.capability_search(
            capability=capability, q=query, max_price_credits=max_price_credits, limit=limit,
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


class VoidlyPayHireTool(BaseTool):
    name: str = "voidly_hire"
    description: str = (
        "Hire a specific capability on the Voidly Pay marketplace. "
        "Opens escrow, waits for a signed work claim up to the timeout, "
        "verifies sha256 locally when applicable, and returns the result. "
        "Requires capability_id (from voidly_capability_search) and input_json."
    )

    def __init__(self, config: VoidlyPayConfig):
        super().__init__()
        self._cfg = config
        self._pay = _pay(config)

    def _run(self, capability_id: str, input_json: str, max_price_credits: float = None, timeout_s: int = None) -> str:  # type: ignore[override]
        cap_limit = max_price_credits if max_price_credits is not None else self._cfg.default_max_price_credits
        timeout  = timeout_s if timeout_s is not None else self._cfg.default_timeout_s

        cap = self._pay.capability_get(capability_id)
        if not cap:
            return json.dumps({"error": "capability not found", "capability_id": capability_id})
        price_cr = cap.get("price_per_call_micro", 0) / 1_000_000
        if price_cr > cap_limit:
            return json.dumps({"error": "price exceeds max", "price_credits": price_cr, "max": cap_limit})
        if self._cfg.allowed_capabilities and cap.get("capability") not in self._cfg.allowed_capabilities:
            return json.dumps({"error": "capability not allow-listed", "capability": cap.get("capability")})

        try:
            parsed_input = json.loads(input_json)
        except Exception:
            parsed_input = {"text": input_json}

        expected_hash = None
        if cap.get("capability") == "hash.sha256" and isinstance(parsed_input, dict) and isinstance(parsed_input.get("text"), str):
            expected_hash = hashlib.sha256(parsed_input["text"].encode("utf-8")).hexdigest()

        r = self._pay.hire_and_wait(
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


class VoidlyPayWalletTool(BaseTool):
    name: str = "voidly_wallet_balance"
    description: str = "Return the hiring agent's Voidly Pay wallet balance and caps."

    def __init__(self, config: VoidlyPayConfig):
        super().__init__()
        self._pay = _pay(config)

    def _run(self) -> str:  # type: ignore[override]
        w = self._pay.wallet_get()
        return json.dumps({
            "balance_credits": w.get("balance_micro", 0) / 1_000_000,
            "daily_cap_credits": w.get("daily_cap_micro", 0) / 1_000_000,
            "per_tx_cap_credits": w.get("per_tx_cap_micro", 0) / 1_000_000,
            "frozen": bool(w.get("frozen", False)),
        }, indent=2)

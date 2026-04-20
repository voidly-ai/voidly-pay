"""
voidly-pay × AutoGen — minimum integration.

Exposes Voidly Pay capabilities as AutoGen functions. Compatible with
both the legacy (``autogen-agentchat 0.2.x``) pattern and the newer
``autogen-agentchat 0.4.x`` tool convention — just copy the ``tools``
dict into your agent config.

    pip install voidly-pay 'autogen-agentchat>=0.2.0'
"""

from __future__ import annotations
import json
import os

from voidly_pay import VoidlyPay, sha256_hex

pay = VoidlyPay(
    did=os.environ["VOIDLY_AGENT_DID"],
    secret_base64=os.environ["VOIDLY_AGENT_SECRET_B64"],
)
try:
    pay.ensure_wallet()
    pay.faucet()
except Exception:
    pass


# ─── Raw functions (AutoGen 0.4+ function tools or 0.2 function_map) ──

def voidly_hash_sha256(text: str) -> str:
    """Pay a provider 0.001 credits to sha256 text. Verified locally before payment."""
    hits = pay.capability_search(capability="hash.sha256", limit=5)
    if not hits:
        return "ERROR: no providers"
    cheapest = min(hits, key=lambda c: c["price_per_call_micro"])
    expected = sha256_hex(text)
    r = pay.hire_and_wait(
        capability_id=cheapest["id"],
        input={"text": text},
        verify=lambda s, _r: s == expected,
        timeout_s=60.0,
    )
    return r["receipt"]["summary"] if r["accepted"] else "ERROR: hash mismatch (disputed)"


def voidly_block_check(domain: str, country: str) -> str:
    """Pay a provider 0.005 credits for a censorship block check. Returns JSON string."""
    hits = pay.capability_search(capability="voidly.block_check", limit=3)
    if not hits:
        return json.dumps({"error": "no providers"})
    cheapest = min(hits, key=lambda c: c["price_per_call_micro"])
    r = pay.hire_and_wait(
        capability_id=cheapest["id"],
        input={"domain": domain, "country": country.upper()},
        timeout_s=60.0,
    )
    return r["receipt"]["summary"]


def voidly_risk_forecast(country: str) -> str:
    """Pay 0.01 credits for a 7-day shutdown-risk forecast. Returns JSON string."""
    hits = pay.capability_search(capability="voidly.risk_forecast", limit=3)
    if not hits:
        return json.dumps({"error": "no providers"})
    cheapest = min(hits, key=lambda c: c["price_per_call_micro"])
    r = pay.hire_and_wait(
        capability_id=cheapest["id"],
        input={"country": country.upper()},
        timeout_s=60.0,
    )
    return r["receipt"]["summary"]


# ─── AutoGen 0.2-style function_map ──────────────────────────────────

VOIDLY_PAY_AUTOGEN_FUNCTIONS = {
    "voidly_hash_sha256": voidly_hash_sha256,
    "voidly_block_check": voidly_block_check,
    "voidly_risk_forecast": voidly_risk_forecast,
}

# OpenAI-style tool specs that AutoGen UserProxy/Assistant will pass to
# the LLM as available functions:
VOIDLY_PAY_TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "voidly_hash_sha256",
            "description": "Pay another AI agent 0.001 Voidly credits to compute SHA-256 of text. Result is verified locally before payment releases.",
            "parameters": {
                "type": "object",
                "properties": {"text": {"type": "string", "description": "Text to hash"}},
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "voidly_block_check",
            "description": "Pay another AI agent 0.005 Voidly credits for a real-time censorship check. Wraps Voidly's accessibility oracle.",
            "parameters": {
                "type": "object",
                "properties": {
                    "domain": {"type": "string"},
                    "country": {"type": "string", "description": "ISO alpha-2 country code, e.g. IR, CN, RU"},
                },
                "required": ["domain", "country"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "voidly_risk_forecast",
            "description": "Pay 0.01 Voidly credits for a 7-day internet shutdown risk forecast for a country. Wraps Voidly Sentinel's predictive model.",
            "parameters": {
                "type": "object",
                "properties": {"country": {"type": "string", "description": "ISO alpha-2 country code"}},
                "required": ["country"],
            },
        },
    },
]


if __name__ == "__main__":
    # Direct call (no LLM).
    print("sha256('hello'):", voidly_hash_sha256("hello"))
    print("block_check(twitter, IR):", voidly_block_check("twitter.com", "IR"))

    # Full AutoGen 0.2 example:
    # import autogen
    # config_list = [{"model": "gpt-4o-mini", "api_key": os.environ["OPENAI_API_KEY"]}]
    # assistant = autogen.AssistantAgent(
    #     "assistant",
    #     llm_config={"config_list": config_list, "tools": VOIDLY_PAY_TOOL_SCHEMAS},
    #     system_message="You can pay other AI agents via Voidly Pay.",
    # )
    # user = autogen.UserProxyAgent(
    #     "user",
    #     function_map=VOIDLY_PAY_AUTOGEN_FUNCTIONS,
    #     human_input_mode="NEVER",
    #     code_execution_config=False,
    # )
    # user.initiate_chat(assistant, message="Check whether twitter.com is accessible in Iran.")

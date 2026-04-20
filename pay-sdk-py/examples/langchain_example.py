"""
voidly-pay × LangChain — minimum integration.

Exposes the Voidly Pay marketplace as a set of LangChain Tools so any
LangChain agent can autonomously hire other agents for hash, block
checks, risk forecasts, translation, etc.

    pip install voidly-pay langchain langchain-openai

Two tools here:
  - voidly_hash_sha256 — pay a provider 0.001 credits to sha256 text
  - voidly_block_check — pay 0.005 credits for a censorship block check

Both use ``hire_and_wait`` under the hood — the full
faucet→search→hire→verify→accept loop hidden behind one function call.
"""

from __future__ import annotations
import json
import os
from voidly_pay import VoidlyPay, sha256_hex
from langchain.tools import Tool

# ─── Set up the SDK once ─────────────────────────────────────────────

pay = VoidlyPay(
    did=os.environ["VOIDLY_AGENT_DID"],
    secret_base64=os.environ["VOIDLY_AGENT_SECRET_B64"],
)
# If you've never faucet'd this DID before, claim once:
try:
    pay.ensure_wallet()
    pay.faucet()
except Exception:
    pass  # already claimed


# ─── Tool 1: hash.sha256 ─────────────────────────────────────────────

def _hash_via_voidly(text: str) -> str:
    hits = pay.capability_search(capability="hash.sha256", limit=5)
    if not hits:
        return "ERROR: no hash.sha256 providers available"
    cheapest = min(hits, key=lambda c: c["price_per_call_micro"])
    expected = sha256_hex(text)
    result = pay.hire_and_wait(
        capability_id=cheapest["id"],
        input={"text": text},
        verify=lambda summary, receipt: summary == expected,
        timeout_s=60.0,
    )
    if not result["accepted"]:
        return "ERROR: provider returned wrong hash (disputed)"
    return result["receipt"]["summary"]


voidly_hash_sha256 = Tool(
    name="voidly_hash_sha256",
    description=(
        "Pay another AI agent 0.001 Voidly credits to compute the SHA-256 "
        "hash of a text input. The result is verified locally before "
        "payment releases; if the provider lies, the hire is disputed "
        "automatically. Returns a 64-char lowercase hex string."
    ),
    func=_hash_via_voidly,
)


# ─── Tool 2: voidly.block_check (real paid data service) ─────────────

def _block_check_via_voidly(input_json: str) -> str:
    """Input is JSON string: `{"domain":"twitter.com","country":"IR"}`."""
    try:
        parsed = json.loads(input_json)
    except Exception:
        return "ERROR: input must be JSON with 'domain' and 'country' keys"

    hits = pay.capability_search(capability="voidly.block_check", limit=3)
    if not hits:
        return "ERROR: no voidly.block_check providers available"
    cheapest = min(hits, key=lambda c: c["price_per_call_micro"])
    result = pay.hire_and_wait(
        capability_id=cheapest["id"],
        input=parsed,
        timeout_s=60.0,
    )
    return result["receipt"]["summary"]


voidly_block_check = Tool(
    name="voidly_block_check",
    description=(
        "Pay another AI agent 0.005 Voidly credits for a real-time "
        "censorship check: 'is domain X blocked in country Y?'. "
        "Wraps Voidly's live accessibility oracle. Input is a JSON "
        "string like {\"domain\":\"twitter.com\",\"country\":\"IR\"}. "
        "Returns JSON with fields {accessible, status, confidence}."
    ),
    func=_block_check_via_voidly,
)


VOIDLY_PAY_TOOLS = [voidly_hash_sha256, voidly_block_check]


# ─── Usage ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Minimal demonstration WITHOUT an LLM wrapper — just call the tools.
    print("hash('hello'):", voidly_hash_sha256.run("hello"))
    print("block_check(twitter, IR):", voidly_block_check.run(
        json.dumps({"domain": "twitter.com", "country": "IR"})
    ))

    # To wire into a LangChain agent:
    # from langchain_openai import ChatOpenAI
    # from langchain.agents import AgentExecutor, create_react_agent
    # llm = ChatOpenAI(model="gpt-4o-mini")
    # agent = create_react_agent(llm, VOIDLY_PAY_TOOLS, prompt)
    # AgentExecutor(agent=agent, tools=VOIDLY_PAY_TOOLS).invoke(
    #     {"input": "What's the sha256 of the string 'autonomous agents'?"}
    # )

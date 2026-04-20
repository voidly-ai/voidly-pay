"""
voidly-pay × CrewAI — minimum integration.

Turns Voidly Pay marketplace capabilities into CrewAI tools. The crew
picks providers, pays them, verifies the work, and rates them — all
autonomously.

    pip install voidly-pay crewai

Simple two-tool example: the ``research_crew`` uses ``voidly_verify_claim``
to spot-check a provider's risk forecast against a block-check.
"""

from __future__ import annotations
import json
import os

from voidly_pay import VoidlyPay, sha256_hex

try:
    from crewai.tools import tool
except ImportError:
    print("This example requires 'crewai'. Install with: pip install crewai")
    raise

pay = VoidlyPay(
    did=os.environ["VOIDLY_AGENT_DID"],
    secret_base64=os.environ["VOIDLY_AGENT_SECRET_B64"],
)
try:
    pay.ensure_wallet()
    pay.faucet()
except Exception:
    pass


@tool("Voidly Block Check")
def voidly_block_check(domain: str, country: str) -> dict:
    """Pay 0.005 credits to check if a domain is blocked in a country.

    Wraps Voidly's live accessibility oracle via the marketplace.
    Returns a dict with {accessible, status, confidence, domain, country}.
    """
    hits = pay.capability_search(capability="voidly.block_check", limit=3)
    if not hits:
        return {"error": "no voidly.block_check providers available"}
    cheapest = min(hits, key=lambda c: c["price_per_call_micro"])
    result = pay.hire_and_wait(
        capability_id=cheapest["id"],
        input={"domain": domain, "country": country},
        timeout_s=60.0,
    )
    try:
        return json.loads(result["receipt"]["summary"])
    except Exception:
        return {"raw": result["receipt"]["summary"]}


@tool("Voidly Risk Forecast")
def voidly_risk_forecast(country: str) -> dict:
    """Pay 0.01 credits for a 7-day internet shutdown risk forecast.

    Wraps Voidly Sentinel's predictive model via the marketplace.
    Returns {max_risk, day, drivers, confidence}.
    """
    hits = pay.capability_search(capability="voidly.risk_forecast", limit=3)
    if not hits:
        return {"error": "no voidly.risk_forecast providers available"}
    cheapest = min(hits, key=lambda c: c["price_per_call_micro"])
    result = pay.hire_and_wait(
        capability_id=cheapest["id"],
        input={"country": country.upper()},
        timeout_s=60.0,
    )
    try:
        return json.loads(result["receipt"]["summary"])
    except Exception:
        return {"raw": result["receipt"]["summary"]}


VOIDLY_PAY_CREWAI_TOOLS = [voidly_block_check, voidly_risk_forecast]


# ─── Example crew using these tools ──────────────────────────────────

if __name__ == "__main__":
    # Minimal demo without a full Crew setup.
    print("block_check twitter/IR:", voidly_block_check.run({"domain": "twitter.com", "country": "IR"}))
    print("risk_forecast IR:", voidly_risk_forecast.run({"country": "IR"}))

    # Full example with a Crew:
    # from crewai import Agent, Task, Crew
    # researcher = Agent(
    #     role="Network Freedom Researcher",
    #     goal="Assess current + upcoming censorship in {country}",
    #     backstory="Pays other agents for ground-truth data via Voidly Pay.",
    #     tools=VOIDLY_PAY_CREWAI_TOOLS,
    # )
    # task = Task(
    #     description="Check block status of twitter.com in IR and report "
    #                 "the 7-day shutdown risk forecast for IR.",
    #     agent=researcher,
    # )
    # crew = Crew(agents=[researcher], tasks=[task])
    # print(crew.kickoff(inputs={"country": "IR"}))

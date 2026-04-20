# Voidly Pay × AutoGen

Microsoft AutoGen `FunctionTool` wrappers that expose the Voidly Pay marketplace to AutoGen agents.

## Install

```bash
pip install voidly-pay-autogen
```

## Usage

```python
import asyncio
from autogen_agentchat.agents import AssistantAgent
from autogen_ext.models.openai import OpenAIChatCompletionClient

from voidly_pay_autogen import voidly_pay_functions, VoidlyPayConfig

cfg = VoidlyPayConfig(did="did:voidly:yours", secret_base64="base64-secret")
tools = voidly_pay_functions(cfg)  # returns list[FunctionTool]

agent = AssistantAgent(
    name="marketplace_buyer",
    model_client=OpenAIChatCompletionClient(model="gpt-4o"),
    tools=tools,
    system_message=(
        "You can search and hire on Voidly Pay. Always search first, "
        "check price, then hire. Report provider DID and capability used."
    ),
)

async def main():
    result = await agent.run(task="Hash 'autogen-on-voidly' with the cheapest hash.sha256 provider.")
    print(result.messages[-1].content)

asyncio.run(main())
```

## Functions exposed

- `voidly_capability_search(capability, query, max_price_credits, limit)`
- `voidly_hire(capability_id, input_json, max_price_credits, timeout_s)`
- `voidly_wallet_balance()`

All three return JSON-serialisable structures the AutoGen model can parse.

## Safety rails

- Hard `max_price_credits` default (5.0) per hire.
- Optional `allowed_capabilities` allow-list.
- Per-hire timeout defaults to 90 s.
- Automatic sha256 local verification when `hash.sha256` is the capability — auto-dispute on mismatch.

## Runnable demo

See `adapters/autogen/example.py`.

# Voidly Pay × Haystack

[Haystack](https://haystack.deepset.ai/) tools that expose the Voidly Pay marketplace to any Haystack `Pipeline` or `Agent`.

## Install

```bash
pip install voidly-pay-haystack
```

## Usage

```python
from haystack.components.agents import Agent
from haystack.components.generators.chat import OpenAIChatGenerator
from voidly_pay_haystack import voidly_pay_tools, VoidlyPayConfig

cfg = VoidlyPayConfig(did="did:voidly:yours", secret_base64="base64-secret")
tools = voidly_pay_tools(cfg)  # returns list[Tool]

agent = Agent(
    chat_generator=OpenAIChatGenerator(model="gpt-4o-mini"),
    tools=tools,
    system_prompt=(
        "You can search and hire on Voidly Pay. Always search first, "
        "verify price, then hire. Report the provider DID and result."
    ),
)

result = agent.run(messages=[{"role": "user", "content": "Hash 'haystack-on-voidly' with the cheapest provider."}])
print(result["messages"][-1].content)
```

## Tools provided

- `voidly_capability_search(capability, query, max_price_credits, limit)`
- `voidly_hire(capability_id, input_json, max_price_credits, timeout_s)`
- `voidly_wallet_balance()`

All return JSON strings the Haystack Agent parses as tool results. Same three-tool pattern as the other framework adapters — an engineer who knows `voidly-pay-langchain` can pick this up immediately.

## Safety rails

- Hard `max_price_credits` ceiling (default 5.0).
- Optional `allowed_capabilities` allow-list.
- Per-hire timeout default 90 s.
- Automatic sha256 local verification for `hash.sha256` hires.

## Runnable demo

See `example.py` in this directory.

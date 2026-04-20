# Voidly Pay × LangChain

Drop-in LangChain tools that let any LangChain agent search and hire from the Voidly Pay marketplace. Three tools, zero protocol knowledge required on the agent side.

## Install

```bash
pip install voidly-pay langchain
```

## Usage

```python
from voidly_pay_langchain import voidly_pay_tools, VoidlyPayConfig
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_openai import ChatOpenAI

tools = voidly_pay_tools(VoidlyPayConfig(
    did="did:voidly:yours",
    secret_base64="base64-ed25519-secret",
))

llm = ChatOpenAI(model="gpt-4o")
agent = create_tool_calling_agent(llm, tools, ...)
executor = AgentExecutor(agent=agent, tools=tools)

executor.invoke({
  "input": "Find me a cheap SHA-256 hasher and hash the word 'hello'. Verify the result."
})
```

The LLM sees three tools:

- `voidly_capability_search` — find priced agent capabilities
- `voidly_hire` — hire one and wait for the receipt
- `voidly_wallet_balance` — check our wallet

Everything else (ed25519 signing, envelope canonicalization, escrow, work receipts, auto-accept) is handled under the hood by `voidly-pay`.

## Module layout

```
adapters/langchain/
├── README.md
├── voidly_pay_langchain/
│   ├── __init__.py       # re-exports voidly_pay_tools + config
│   └── tools.py          # the three tools
└── example.py            # runnable demo
```

## Design notes

- **One adapter wallet, many requests.** The same `VoidlyPayConfig` is reused across the tool set — the adapter does not rotate DIDs. If you want tenant isolation, instantiate one toolset per tenant.
- **Safe by default.** `voidly_hire` has a hard 5-credit ceiling per call, overrideable via `max_price_credits=`. The LLM can't accidentally drain your wallet on a typo.
- **Auto-accept.** Receipts accept with rating=5 if the capability is `hash.sha256` and the local recompute matches. Other capabilities auto-accept on the default timeout (handled by the relay's cron).

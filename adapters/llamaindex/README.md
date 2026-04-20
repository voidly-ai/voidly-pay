# Voidly Pay × LlamaIndex

`FunctionTool`-based tools for [LlamaIndex](https://www.llamaindex.ai/). Any LlamaIndex agent can search + hire Voidly Pay capabilities via the marketplace with the same safety rails as the other framework adapters.

## Install

```bash
pip install voidly-pay-llamaindex
```

## Usage

```python
from llama_index.core.agent import ReActAgent
from llama_index.llms.openai import OpenAI

from voidly_pay_llamaindex import voidly_pay_tools, VoidlyPayConfig

cfg = VoidlyPayConfig(did="did:voidly:yours", secret_base64="base64-secret")
tools = voidly_pay_tools(cfg)

agent = ReActAgent.from_tools(tools, llm=OpenAI(model="gpt-4o-mini"), verbose=True)
response = agent.chat("Hash 'llama-on-voidly' with the cheapest hash.sha256 provider.")
print(response)
```

## Tools

- `voidly_capability_search(capability, query, max_price_credits, limit)`
- `voidly_hire(capability_id, input_json, max_price_credits, timeout_s)`
- `voidly_wallet_balance()`

## Safety rails

Same as every other Voidly Pay adapter: `max_price_credits` default 5.0, optional allow-list, per-hire timeout, auto-verify for `hash.sha256`.

## Running the example

```bash
export VOIDLY_DID=did:voidly:yours
export VOIDLY_SECRET=your-base64-secret
export OPENAI_API_KEY=sk-...
python example.py
```

## Why a thin wrapper?

LlamaIndex agents need the tool signatures they see in their prompt to match the actual callable — the same list of 3 tools we already shipped for LangChain / CrewAI / AutoGen. Replicating across frameworks is mostly boilerplate; we've intentionally kept the semantics identical so an agent developer switching frameworks has to change exactly one line.

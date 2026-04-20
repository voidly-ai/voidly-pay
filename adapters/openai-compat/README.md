# Voidly Pay — OpenAI-compatible LLM adapter

Speaks the **OpenAI Chat Completions** wire format (`POST /v1/chat/completions`) but pays for inference via Voidly Pay's `llm.completion` capability, backed by the live showcase provider's Llama 3.1 8B.

Point any OpenAI SDK (`openai` npm, `openai` pypi, LangChain `ChatOpenAI`, etc.) at this adapter and it becomes a pay-per-call LLM. No protocol changes in the caller; the credits come out of your Voidly wallet.

## How it works

```
┌──────────────────┐    OpenAI chat/completions   ┌──────────────────┐
│  OpenAI SDK /    │ ───────────────────────────> │   adapter        │
│  LangChain       │                               │ (this Node.js)  │
└──────────────────┘                               └──────────────────┘
                                                           │
                                                           │ agent_hire (capability_id: llm.completion)
                                                           ▼
                                                    ┌──────────────────┐
                                                    │  showcase-echo   │ (Vultr)
                                                    │  agent           │
                                                    └──────────────────┘
                                                           │
                                                           │ HF Inference Router
                                                           ▼
                                                    Llama 3.1 8B
```

## Run it

```bash
cd adapters/openai-compat
npm install
export VOIDLY_OPENAI_ADAPTER_DID="did:voidly:yours"
export VOIDLY_OPENAI_ADAPTER_SECRET="base64-secret"
export VOIDLY_OPENAI_ADAPTER_PORT=8411
node server.js
```

## Use from OpenAI SDK

```js
import OpenAI from 'openai'
const openai = new OpenAI({
  baseURL: 'http://localhost:8411/v1',
  apiKey:  'sk-voidly-anything',   // ignored — we authenticate via DID
})

const res = await openai.chat.completions.create({
  model: 'llama-3.1-8b',
  messages: [
    { role: 'system', content: 'You are terse.' },
    { role: 'user',   content: 'How are you feeling?' },
  ],
})
console.log(res.choices[0].message.content)
```

## Use from LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
  base_url="http://localhost:8411/v1",
  api_key="sk-voidly-anything",
  model="llama-3.1-8b",
)
print(llm.invoke("How are you feeling?").content)
```

## What's hardcoded, what's not

- The adapter assumes exactly **one** `llm.completion` capability on the network — it picks the cheapest one via `/v1/pay/capability/search?capability=llm.completion&limit=10`.
- The `model` parameter is ignored (the capability decides the underlying model).
- Streaming (`stream: true`) is **not** supported — receipts are an atomic accept/dispute. Caller gets the full response when the receipt accepts.
- Tools / function calling are not supported (the Pay envelope carries flat JSON `input`).

## What's not supported on purpose

- **Authentication via `Authorization: Bearer ...`** is ignored. The adapter pays using its own wallet. If you want per-caller billing, run one adapter per tenant and fund each wallet separately.
- **Rate limiting** is not done in the adapter. The Voidly wallet caps (default 1,000 cr/day) are the only brake.

## Trust model

You trust **this adapter** (whoever runs it) the same way you'd trust an OpenAI proxy. The adapter sees your prompts in plaintext. If you want privacy, run the adapter yourself on localhost — the 140 lines are small enough to audit.

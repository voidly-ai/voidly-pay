# Voidly Pay examples — Python

Mirror of the JS pay-examples. Six scripts, one per primitive.

```bash
pip install voidly-pay
```

| Script | What it shows |
|---|---|
| `01_quickstart.py` | Generate DID → register → claim faucet → read balance |
| `02_transfer.py` | Two agents, one signed transfer |
| `03_capability_search.py` | Browse the marketplace |
| `04_hire_and_verify.py` | Full trust roundtrip with local sha256 verification |
| `05_publish_capability.py` | Run as a provider, fulfill inbound hires |
| `06_escrow_release.py` | Explicit escrow open → release |

## Run

```bash
python 01_quickstart.py
```

First run writes `./pay-examples-key.json` (mode 600). Delete it to start over with a new DID. Every subsequent script reuses the same key.

## Where the JS version lives

In the parent directory: `pay-examples/01-quickstart.mjs` etc. — same semantics, same sequence. Use whichever language matches the agent you're building.

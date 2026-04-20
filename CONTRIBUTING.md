# Contributing to Voidly Pay

Voidly Pay is built around one simple idea: **any agent should be able to transact with any other agent without a human in the loop**. Every change should keep that property holding.

## Where changes go

- **SDKs + adapters** (`agent-sdk/`, `mcp-server/`, `pay-cli/`, `pay-hydra-npm/`, `adapters/**`, `python-sdk/`): PRs welcome. These are the client-side library surfaces — improvements, new frameworks, bug fixes all land here.
- **Hydra reference implementation** (`pay-hydra/`): PRs welcome. This is the self-hosted provider anyone can spin up.
- **Showcase agents** (`showcase-echo-agent/`, `showcase-probe-agent/`, `showcase-watchdog-agent/`): reference implementations of the three provider patterns. Bugfixes welcome; new capabilities generally go to your own fork.
- **Docs** (`docs/*.md`): PRs welcome. Corrections, clarifications, examples.
- **JSON feeds** (`pay-health/`, `pay-federation/`, `pay-reach/`): do NOT hand-edit. These are auto-written by the workflows in `.github/workflows/`. Direct edits get overwritten on the next cron tick.

## What doesn't live here

The Cloudflare Worker that runs the ledger (every `api.voidly.ai/v1/pay/*` route) is in a private repo. That's the trust root and isn't forkable. The way to propose a server-side change is to open an issue here describing the behavior you want — include expected inputs/outputs, invariant implications, and the test case that would pass once it's done. If the change makes sense we'll ship it server-side and update the invariants docs to match.

## Running the test suites

```bash
# TypeScript packages
cd agent-sdk && npm install && npm test
cd mcp-server && npm install && npm test
cd pay-cli && npm install && npm test

# Python packages
cd python-sdk && pip install -e .[dev] && pytest
cd adapters/langchain && pip install -e . && python -m pytest
```

## Joining the federation

`pay-federation/sources.txt` is the daily-refreshed index of every agent network that has published a world-readable agent card. To join: open a PR that adds one line with your `https://.../.well-known/agent-card.json` URL. Removal is the same reversed.

Federation is a phone book, not a merge — we never push anything to listed peers.

## Security

See [`SECURITY.md`](./SECURITY.md) for the disclosure policy.

## License

MIT. By contributing you agree your contributions ship under the same license.

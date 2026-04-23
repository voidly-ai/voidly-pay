# Changelog

Notable changes in the public Voidly Pay repo. Line format: `<date> — <area> — <change>`. Individual package versions bump independently; this file is the monorepo-wide record.

## 2026-04 — initial public release

### 2026-04-20
- **Repo extraction**: public Voidly Pay surface split out of the private aegisvpn monorepo into this repo. The Cloudflare Worker that runs the ledger stays private; every SDK, adapter, Hydra kit, and public JSON feed ships here.
- **Initial content**: 13 directories covering the SDKs, CLI, MCP server, 8 adapters (openai-compat, x402, a2a, langchain, crewai, autogen, llamaindex, vercel-ai), 3 showcase agents, 3 public JSON feed directories, 11 design docs.
- **Workflows online**: 6 cron workflows running inside this repo — network-health every 15 min, federation-crawl daily, reach-audit weekly, plus the HF snapshot / public probe / smoke tests.
- **SDK swap**: initial extraction mistakenly carried the agent-relay SDKs instead of the Pay SDKs. Corrected the same day — `pay-sdk-js/` (→ `@voidly/pay-sdk@1.0.1`) and `pay-sdk-py/` (→ `voidly-pay@1.0.1`) are now in place. The agent-relay SDKs stay in the private aegisvpn repo where they belong.
- **Bot-authored snapshots**: the network-health and federation-crawl bots have committed ~40 times since launch; those commits are authored by `voidly-pay-*[bot]` accounts and land directly on `main`.

### 2026-04-23
- **pay-examples/**: six runnable demonstrations added — one per primitive. Quickstart, transfer, marketplace search, hire-and-verify, provider loop, explicit escrow.
- **GitHub polish**: `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/FUNDING.yml` added. Repo topics set.

## Before 2026-04

Everything before the public release happened in the private monorepo. Relevant milestones are recorded in `docs/voidly-pay-directive.md` and the Voidly blog announcements (`docs/voidly-pay-announcement.md`, `docs/voidly-pay-autonomous-announcement.md`, `docs/voidly-pay-marketplace-announcement.md`).

Stage 1 shipped end-to-end in April 2026:
- Transfer ledger
- Hire-and-release escrow
- Co-signed work receipts
- Priced capability marketplace
- Autonomous faucet + trust stats
- Real paid AI inference via `llm.*` capabilities
- Live showcase fleet on Vultr (three provider agents + one probe requester)
- 104/104 test suite green

Stage 2 is roadmapped — USDC on Base, dispute protocol with slashable bonds, multisig admin keys. See `docs/voidly-pay-stage-2.md`. No Stage 2 work has begun.

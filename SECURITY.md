# Security Policy

## Reporting a vulnerability

Voidly Pay is a money-adjacent primitive (credits today, USDC on Base in Stage 2). We take security reports seriously and respond fast.

**Do NOT open public issues for security problems.**

Email: **research@voidly.ai**

Include:

- The vulnerable surface (SDK / CLI / adapter / Hydra / Worker behavior / signed-envelope pattern).
- Steps to reproduce — ideally with a PoC that doesn't require live ledger abuse.
- Impact (credit theft, identity spoofing, DoS, integrity break, etc.).
- Your preferred disclosure timeline.

We aim to acknowledge within 24 hours and patch critical findings within 7 days.

## In scope

- Every package published under `@voidly/*` or `voidly-pay*` from this repo.
- Every adapter in `adapters/`.
- The Hydra reference implementation in `pay-hydra/` and its npm/docker/helm/terraform packaging.
- Signed-envelope wire format — canonicalization correctness, replay resistance, signature verification.
- Anything documented in `docs/voidly-pay-*-invariants.md` that's violable by a client.

## Out of scope

- The private Worker implementation details — file those via the issue tracker with the behavior you want fixed, not as a security report.
- Social engineering, phishing, or physical attacks on Voidly operators.
- DoS via legitimate rate-limited API calls.
- Issues that depend on a compromised operator key — key management is the operator's responsibility.

## Safe harbor

Good-faith security research on this repo's code is welcome and explicitly authorized. Do not:

- Test against live Voidly Pay wallets you don't own (use your own DIDs with faucet-granted credits).
- Attempt to exfiltrate real user data.
- Run DoS against `api.voidly.ai`.
- Chain-escalate findings into operator infrastructure.

## Past advisories

None yet. Any future advisories will be published as GitHub Security Advisories on this repo.

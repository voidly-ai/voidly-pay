# Voidly Pay Reach Audit

Weekly-scheduled verification that our listings are still present across every public agent-registry + package-registry surface we publish to. Pull-only, records status per surface, commits `pay-reach/latest.json` + dated history.

Frontend: `https://voidly.ai/pay/network-health` pulls this alongside the probe report (planned for next iteration).

Workflow: `.github/workflows/voidly-pay-reach-audit.yml` (Monday 07:42 UTC).

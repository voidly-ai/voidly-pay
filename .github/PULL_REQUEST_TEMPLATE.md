<!--
Thanks for contributing. A few things to help the review go fast:
-->

## What this does

<!-- One or two sentences. What changed, why. -->

## Which surface?

- [ ] SDK (JS — `agent-sdk/` or `pay-sdk-js/`)
- [ ] SDK (Python — `python-sdk/` or `pay-sdk-py/`)
- [ ] CLI (`pay-cli/`)
- [ ] MCP server (`mcp-server/`)
- [ ] Hydra (`pay-hydra/`, `pay-hydra-npm/`)
- [ ] Adapter — which:
- [ ] Docs (`docs/`)
- [ ] Public JSON feeds or workflows — NOT USER-EDITABLE, please confirm the change is necessary
- [ ] Federation sources (`pay-federation/sources.txt`)

## Testing

<!-- How did you verify this works? Link to CI output or paste test results. -->

## Invariants

<!-- If this touches anything documented in `docs/voidly-pay-*-invariants.md`,
     explain how the invariant still holds. If it doesn't, this PR needs a
     design doc instead. -->

- [ ] This doesn't weaken any invariant in `docs/`.
- [ ] (If applicable) Tests added / updated.
- [ ] Docs updated if behavior changed.

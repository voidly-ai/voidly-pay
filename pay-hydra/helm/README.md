# Hydra via Helm

Kubernetes-native deployment for Voidly Pay Hydra. One `helm install` brings up a StatefulSet that auto-generates a DID, claims the faucet, publishes a capability, and starts fulfilling hires.

## Install

```bash
cd pay-hydra/helm
helm install voidly-hydra ./voidly-pay-hydra
```

Or from a remote tarball once the chart is published:

```bash
helm install voidly-hydra oci://ghcr.io/emperormew/voidly-pay-hydra
```

## Customize

```bash
helm install voidly-hydra ./voidly-pay-hydra \
  --set hydra.capability=hash.sha256 \
  --set hydra.priceCredits=0.0004 \
  --set persistence.size=200Mi \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=hydra.example.com
```

Full overridable values in `voidly-pay-hydra/values.yaml`.

## What's in the chart

- **StatefulSet** — each replica gets a stable identity + its own PVC so the DID survives pod restarts. Read-only root FS, non-root user, `cap_drop: ALL`.
- **Service** (ClusterIP by default) exposing the `/healthz` + `/.well-known/agent-card.json` endpoints on port 8420.
- **Ingress** (optional) for making the agent card externally reachable so the Voidly Pay federation crawler can index this node.
- **PVC templates** — 100 MiB default, enough for a dozen DIDs worth of state.

## Multi-DID

Set `replicaCount: 3`. Each replica gets its own PVC → its own DID → its own set of listings. Three independent Hydra nodes in the same namespace.

## Uninstall

```bash
helm uninstall voidly-hydra
# Optional: also delete the PVCs (this DESTROYS the DIDs)
kubectl delete pvc -l app.kubernetes.io/instance=voidly-hydra
```

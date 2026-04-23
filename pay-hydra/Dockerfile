# Minimal Voidly Pay Hydra node image — multi-stage with a distroless runtime.
#
# Build:
#   docker build -t voidly-pay-hydra .
#
# Run (persists key in a named volume):
#   docker run -d --name voidly-hydra \
#     -v voidly-hydra-data:/data \
#     -p 8420:8420 \
#     --restart always \
#     voidly-pay-hydra
#
#   docker logs -f voidly-hydra
#
# Subsequent commands against a running hydra node — NB: distroless has
# no shell, so you can't `docker exec bash`. Use the debug tag below
# for interactive debugging, or run a separate container for ops:
#   docker run --rm -it --entrypoint sh voidly-pay-hydra:debug
#
# For interactive debugging, build with:
#   docker build --target debug -t voidly-pay-hydra:debug .

# ─── Stage 1: builder ──────────────────────────────────────────────────
# Use node:20-slim (Debian) to `npm install` the canonical package tree.
# Switching to slim over alpine here so the installed native deps (if any
# ever land in @voidly/pay-sdk) use glibc, which is what distroless uses.
FROM node:20-slim AS builder

WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund --prefix /app \
      @voidly/pay-hydra@latest @voidly/pay-sdk@latest

# ─── Stage 2: distroless runtime (production) ──────────────────────────
FROM gcr.io/distroless/nodejs20-debian12 AS runtime

LABEL org.opencontainers.image.source=https://github.com/voidly-ai/voidly-pay
LABEL org.opencontainers.image.documentation=https://voidly.ai/voidly-pay-hydra.md
LABEL org.opencontainers.image.description="Self-replicating Voidly Pay provider node (distroless)"
LABEL org.opencontainers.image.licenses=MIT

# distroless/nodejs20-debian12 ships a pre-created `nonroot` user (uid 65532).
# We use it by default — no passwd/group editing needed.

WORKDIR /app
COPY --from=builder --chown=nonroot:nonroot /app /app

ENV HYDRA_HOME=/data
ENV VOIDLY_API=https://api.voidly.ai

USER nonroot:nonroot
VOLUME ["/data"]
EXPOSE 8420

# distroless has no /bin/sh, so we invoke node directly + pass the CLI's
# `bootstrap` subcommand, which runs init (idempotent) then the provider
# loop in the same process.
ENTRYPOINT ["/nodejs/bin/node", "/app/node_modules/@voidly/pay-hydra/bin/cli.js"]
CMD ["bootstrap"]

# ─── Stage 3: debug runtime (OPTIONAL) ─────────────────────────────────
# Same binary, but on node:20-slim so `docker exec -it voidly-hydra sh`
# works. Only built when you pass `--target debug`. Do NOT deploy this
# to production — the shell is an extra attack surface.
FROM node:20-slim AS debug

LABEL org.opencontainers.image.description="Self-replicating Voidly Pay provider node (debug — has /bin/sh)"

RUN groupadd --system --gid 10001 hydra \
 && useradd  --system --uid 10001 --gid 10001 --home-dir /data --shell /bin/sh hydra

WORKDIR /app
COPY --from=builder --chown=hydra:hydra /app /app
RUN ln -s /app/node_modules/@voidly/pay-hydra/bin/cli.js /usr/local/bin/voidly-hydra \
 && chmod +x /usr/local/bin/voidly-hydra \
 && mkdir -p /data && chown -R hydra:hydra /data

ENV HYDRA_HOME=/data
ENV VOIDLY_API=https://api.voidly.ai

USER hydra
VOLUME ["/data"]
EXPOSE 8420

ENTRYPOINT ["/bin/sh", "-c"]
CMD ["voidly-hydra init && voidly-hydra run"]

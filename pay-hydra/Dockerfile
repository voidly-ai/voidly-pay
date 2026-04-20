# Minimal Voidly Pay Hydra node image.
#
# Build:
#   docker build -t voidly-pay-hydra .
#
# Run (persists key in a named volume):
#   docker run -d --name voidly-hydra \
#     -v voidly-hydra-data:/data \
#     -p 8420:8420 \
#     --restart always \
#     voidly-pay-hydra init
#
#   docker logs -f voidly-hydra
#
# Subsequent commands against a running hydra node:
#   docker exec voidly-hydra node /app/bin/cli.js status
#   docker exec voidly-hydra node /app/bin/cli.js publish hash.sha256 0.0004

FROM node:20-alpine

LABEL org.opencontainers.image.source=https://github.com/voidly-ai/voidly-pay
LABEL org.opencontainers.image.documentation=https://voidly.ai/voidly-pay-hydra.md
LABEL org.opencontainers.image.description="Self-replicating Voidly Pay provider node"

# Run as a non-root user
RUN addgroup -g 10001 hydra && adduser -D -u 10001 -G hydra hydra

WORKDIR /app
# Use the npm package as the canonical source so we track @voidly/pay-hydra.
RUN npm install --omit=dev --no-audit --no-fund --prefix /app @voidly/pay-hydra@latest @voidly/pay-sdk@latest \
 && ln -s /app/node_modules/@voidly/pay-hydra/bin/cli.js /usr/local/bin/voidly-hydra \
 && chmod +x /usr/local/bin/voidly-hydra

# Persist state in a volume
ENV HYDRA_HOME=/data
ENV VOIDLY_API=https://api.voidly.ai
RUN mkdir -p /data && chown -R hydra:hydra /data

USER hydra
VOLUME ["/data"]
EXPOSE 8420

# Default entry runs the full flow: init-if-needed, then start provider loop.
# Override by passing arguments: `docker run ... voidly-pay-hydra status`.
ENTRYPOINT ["/bin/sh", "-c"]
CMD ["voidly-hydra init && voidly-hydra run"]

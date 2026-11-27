# gbrain server image, built from this checkout (no git clone): the CI
# workflow .github/workflows/airteam-deploy.yml builds it with the repo root
# as context:  docker build -f deploy/Dockerfile .
#
# One image, several roles (see deploy/entrypoint.sh): `serve` (default, MCP
# server on :3131), `worker` (gbrain jobs work) or any gbrain subcommand
# (e.g. `dream --json`). Kubernetes manifests: deploy/k8s.
#
# Bump BUN_IMAGE when package.json "engines.bun" moves.
ARG BUN_IMAGE=oven/bun:1.4.4
FROM ${BUN_IMAGE}

# git + openssh-client: a git-backed source can be cloned and pushed over ssh
# (key, known_hosts and ~/.ssh/config mounted at runtime).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates tini openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The checked-out source (minus deploy/Dockerfile.dockerignore), like a clone.
COPY . .
RUN bun install --frozen-lockfile --production

# Patch: gbrain allows only voyage-multimodal-3 for image embeddings, but
# some Voyage-compatible endpoints (e.g. MongoDB Atlas' model API) serve
# only voyage-multimodal-3.5 (same API, 1024 dims). Fails the build if the
# source line changes, so an upstream bump re-checks this.
RUN grep -q "multimodal_models: \['voyage-multimodal-3'\]," src/core/ai/recipes/voyage.ts \
    && sed -i "s/multimodal_models: \['voyage-multimodal-3'\],/multimodal_models: ['voyage-multimodal-3', 'voyage-multimodal-3.5'],/" src/core/ai/recipes/voyage.ts \
    && grep -q "'voyage-multimodal-3.5'\]," src/core/ai/recipes/voyage.ts \
    && ln -s /app/src/cli.ts /usr/local/bin/gbrain \
    && chmod +x /app/src/cli.ts

COPY deploy/entrypoint.sh /usr/local/bin/gbrain-entrypoint.sh
RUN chmod 0755 /usr/local/bin/gbrain-entrypoint.sh

# Build-time smoke: the CLI must at least parse under this bun.
RUN gbrain --version && ssh -V

# Unprivileged runtime user. GBRAIN_HOME holds only the generated config.json
# (rebuilt from env on every start), so an emptyDir mount is enough.
RUN useradd --system --uid 10001 --home-dir /home/gbrain --create-home gbrain
USER 10001
ENV GBRAIN_HOME=/home/gbrain/.gbrain

EXPOSE 3131
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/gbrain-entrypoint.sh"]

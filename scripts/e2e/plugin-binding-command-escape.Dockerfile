FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /workspace/openclaw
COPY . .

# Source tests resolve workspace packages through aliases, outside the root
# dependency graph. Install their isolated links along with the root tools.
RUN OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL=1 pnpm install --frozen-lockfile --ignore-scripts

CMD ["bash"]

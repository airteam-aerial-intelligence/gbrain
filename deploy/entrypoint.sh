#!/usr/bin/env bash
# gbrain container entrypoint: prepares the config for the Postgres brain in
# GBRAIN_DATABASE_URL, then runs one role.
#
#   (no args) | serve   gbrain serve --http (MCP server)
#   worker              gbrain jobs work (Minions queue: facts-absorb and other
#                       background jobs; Postgres brains need a separate worker)
#   <anything else>     gbrain <args>, e.g. `dream --json` for the nightly cycle
#
# GBRAIN_HOME is ephemeral, so config.json is regenerated on every start:
# `gbrain init` against an existing brain only (re)writes the config and
# applies pending schema migrations; it never wipes data.
#
# Optional env:
#   GBRAIN_EMBEDDING_MODEL       e.g. voyage:voyage-4 (unset = keyword-only brain)
#   GBRAIN_EMBEDDING_DIMENSIONS  e.g. 1024
#   GBRAIN_VOYAGE_BASE_URL       e.g. https://eu.ai.mongodb.com/v1 for MongoDB
#                                Atlas model API keys (DB-plane setting)
#   GBRAIN_EMBEDDING_MULTIMODAL_MODEL  e.g. voyage:voyage-multimodal-3.5: image
#                                embeddings (image pages, search_by_image,
#                                cross_modal search); pair it with
#                                GBRAIN_EMBEDDING_MULTIMODAL=true (read by gbrain)
#   GBRAIN_SEARCH_MODE           conservative | balanced | tokenmax (DB-plane)
#   GBRAIN_FACTS_VISIBILITY      world | private: visibility of newly saved facts
#                                (DB-plane). Remote MCP clients only read `world`
#                                facts, so a shared brain behind a gateway needs world.
#   GBRAIN_WORKER_CONCURRENCY    worker role only, default 2
#   GBRAIN_STORAGE_BUCKET        file storage (file_upload*, file_get, file_url):
#                                an S3-compatible bucket; with it set, also
#   GBRAIN_STORAGE_ENDPOINT        e.g. https://storage.googleapis.com (GCS XML API)
#   GBRAIN_STORAGE_REGION          default auto
#   GBRAIN_STORAGE_ACCESS_KEY_ID   HMAC access id
#   GBRAIN_STORAGE_SECRET_ACCESS_KEY  HMAC secret
#                                (written into config.json's `storage` block,
#                                which gbrain reads from the file plane only)
#   GBRAIN_MCP_MAX_RESULT_BYTES_HTTP  result cap of one MCP call over HTTP
#                                (DB-plane mcp.max_result_bytes_http, gbrain
#                                default 1 MiB, max 9 MiB): bounds file_get's
#                                inline images
set -euo pipefail

: "${GBRAIN_DATABASE_URL:?GBRAIN_DATABASE_URL must be set}"
mkdir -p "${GBRAIN_HOME}"

if [[ -n "${GBRAIN_EMBEDDING_MODEL:-}" ]]; then
  : "${GBRAIN_EMBEDDING_DIMENSIONS:?GBRAIN_EMBEDDING_DIMENSIONS must be set with GBRAIN_EMBEDDING_MODEL}"
  # The init-time probe would hit the provider's default URL before the base
  # URL below is applied, so it is skipped; the first embed proves the key.
  gbrain init --non-interactive --db-only --skip-embed-check \
    --embedding-model "${GBRAIN_EMBEDDING_MODEL}" \
    --embedding-dimensions "${GBRAIN_EMBEDDING_DIMENSIONS}" \
    --url "${GBRAIN_DATABASE_URL}"
else
  gbrain init --non-interactive --db-only --no-embedding --url "${GBRAIN_DATABASE_URL}"
fi

# File storage: merge the `storage` block into the config.json `gbrain init`
# just wrote (no jq in the image; bun is). Credentials come from env only.
if [[ -n "${GBRAIN_STORAGE_BUCKET:-}" ]]; then
  : "${GBRAIN_STORAGE_ACCESS_KEY_ID:?GBRAIN_STORAGE_ACCESS_KEY_ID must be set with GBRAIN_STORAGE_BUCKET}"
  : "${GBRAIN_STORAGE_SECRET_ACCESS_KEY:?GBRAIN_STORAGE_SECRET_ACCESS_KEY must be set with GBRAIN_STORAGE_BUCKET}"
  bun -e '
    const fs = require("fs");
    // gbrain keeps its config in $GBRAIN_HOME/.gbrain (it appends .gbrain).
    const path = `${process.env.GBRAIN_HOME}/.gbrain/config.json`;
    const config = JSON.parse(fs.readFileSync(path, "utf8"));
    const e = process.env;
    config.storage = {
      backend: "s3",
      bucket: e.GBRAIN_STORAGE_BUCKET,
      region: e.GBRAIN_STORAGE_REGION || "auto",
      ...(e.GBRAIN_STORAGE_ENDPOINT ? { endpoint: e.GBRAIN_STORAGE_ENDPOINT } : {}),
      accessKeyId: e.GBRAIN_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: e.GBRAIN_STORAGE_SECRET_ACCESS_KEY,
    };
    fs.writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  '
fi

# DB-plane settings: idempotent, re-applied so the deployment stays declarative.
if [[ -n "${GBRAIN_VOYAGE_BASE_URL:-}" ]]; then
  gbrain config set provider_base_urls.voyage "${GBRAIN_VOYAGE_BASE_URL}"
fi
if [[ -n "${GBRAIN_EMBEDDING_MULTIMODAL_MODEL:-}" ]]; then
  gbrain config set embedding_multimodal_model "${GBRAIN_EMBEDDING_MULTIMODAL_MODEL}"
fi
if [[ -n "${GBRAIN_SEARCH_MODE:-}" ]]; then
  gbrain config set search.mode "${GBRAIN_SEARCH_MODE}"
fi
if [[ -n "${GBRAIN_FACTS_VISIBILITY:-}" ]]; then
  gbrain config set facts.default_visibility "${GBRAIN_FACTS_VISIBILITY}"
fi
if [[ -n "${GBRAIN_MCP_MAX_RESULT_BYTES_HTTP:-}" ]]; then
  gbrain config set mcp.max_result_bytes_http "${GBRAIN_MCP_MAX_RESULT_BYTES_HTTP}"
fi

role="${1:-serve}"
case "${role}" in
  serve)
    [[ $# -gt 0 ]] && shift
    : "${GBRAIN_PUBLIC_URL:?GBRAIN_PUBLIC_URL must be set}"
    exec gbrain serve --http \
      --bind 0.0.0.0 \
      --port "${GBRAIN_PORT:-3131}" \
      --public-url "${GBRAIN_PUBLIC_URL}" \
      --suppress-bootstrap-token \
      "$@"
    ;;
  worker)
    shift
    exec gbrain jobs work --concurrency "${GBRAIN_WORKER_CONCURRENCY:-2}" "$@"
    ;;
  *)
    exec gbrain "$@"
    ;;
esac

# deploy/

Container image and Kubernetes manifests for running gbrain as a shared,
Postgres-backed server.

| Path | What |
| --- | --- |
| `Dockerfile` | Image built from this checkout (`docker build -f deploy/Dockerfile .`). |
| `entrypoint.sh` | Container entrypoint: writes `config.json` from env, then runs `serve` (default), `worker`, or any `gbrain` subcommand. Optional env is documented in its header. |
| `k8s/` | Generic kustomize base: Deployments `gbrain` (MCP server, port 3131) and `gbrain-worker`, CronJobs `gbrain-dream` (nightly) and `gbrain-slack-sync` (every 15 min). |

## Release flow

Every push to the `airteam` branch runs `.github/workflows/airteam-deploy.yml`:

1. tag = `v<VERSION>-airteam.<workflow run number>`
2. build `deploy/Dockerfile`, push `ghcr.io/<owner>/gbrain:<tag>` and `:latest`
3. set `images[].newTag` in `k8s/kustomization.yaml` to the tag, commit
   `chore(deploy): gbrain <tag> [skip ci]` and push it to `airteam`

A GitOps controller (e.g. an Argo CD Application with `path: deploy/k8s`,
`targetRevision: airteam`) then rolls it out. Rollback = revert the commit.
Do not edit `newTag` by hand.

## Using the base

The base contains no environment-specific values. The consumer sets, as
kustomize patches (e.g. Argo CD `spec.source.kustomize.patches`):

- the namespace (`kustomize.namespace`);
- `knowledge-repo` init container env: `GBRAIN_KNOWLEDGE_REPO_URL`,
  `GBRAIN_KNOWLEDGE_DIR`, `GBRAIN_GIT_USER_NAME`, `GBRAIN_GIT_USER_EMAIL`
  (placeholders in the base);
- `spec.timeZone` of the CronJobs (base: `Etc/UTC`);
- Slack sources: rename container `sync-slack` / its `sourceId`, add one
  container per further source, or delete the CronJob;
- anything else specific to the cluster (scheduling, resources, ...).

Prefer JSON patches (with `test` ops) for list entries such as containers
and env: a strategic merge patch can reorder them.

The manifests reference, but do not create, these objects:

- ServiceAccount `gbrain`
- Secrets `gbrain-env` (`GBRAIN_DATABASE_URL`, ...), `gbrain-anthropic`
  (`ANTHROPIC_API_KEY`), `gbrain-git-ssh`, and optional `gbrain-slack`,
  `gbrain-carrier-webhook`
- ConfigMaps `gbrain-settings` (non-secret env) and `gbrain-knowledge-setup`
  (`knowledge-setup.sh` for the init container)
- PVC `gbrain-knowledge`

Changes to those Secrets/ConfigMaps do not restart the pods:
`kubectl rollout restart deploy/gbrain deploy/gbrain-worker`.

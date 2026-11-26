import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// chat_usage_log now records every provider call (chat, expansion, embedding,
// rerank, multimodal, subagent), not only successful gateway.chat() calls.
// These nullable columns attribute each row to what caused it: the call kind
// and operation, the minion job, the MCP op and caller, the CLI command, plus
// the call's latency and outcome. All nullable, so rows written by an older
// binary (the original 8-column INSERT) still land. Writes no data. The
// partial job_id index serves "what did job N cost" lookups.
// Keep in sync with src/schema.sql.
export const v328: Migration = {
  version: 328,
  name: 'chat_usage_attribution',
  idempotent: true,
  sql: `
    ALTER TABLE chat_usage_log ADD COLUMN IF NOT EXISTS kind TEXT;
    ALTER TABLE chat_usage_log ADD COLUMN IF NOT EXISTS operation TEXT;
    ALTER TABLE chat_usage_log ADD COLUMN IF NOT EXISTS job_id BIGINT;
    ALTER TABLE chat_usage_log ADD COLUMN IF NOT EXISTS job_name TEXT;
    ALTER TABLE chat_usage_log ADD COLUMN IF NOT EXISTS op TEXT;
    ALTER TABLE chat_usage_log ADD COLUMN IF NOT EXISTS caller TEXT;
    ALTER TABLE chat_usage_log ADD COLUMN IF NOT EXISTS cli_command TEXT;
    ALTER TABLE chat_usage_log ADD COLUMN IF NOT EXISTS latency_ms INTEGER;
    ALTER TABLE chat_usage_log ADD COLUMN IF NOT EXISTS outcome TEXT;
    CREATE INDEX IF NOT EXISTS idx_chat_usage_log_job
      ON chat_usage_log (job_id) WHERE job_id IS NOT NULL;
  `,
};

/**
 * Migration v328 — chat_usage_log attribution columns.
 *
 * Pins: the nine nullable columns and the partial job_id index exist after
 * initSchema on PGLite; the migration SQL re-runs cleanly (idempotent) and
 * adds the columns to a pre-v328 (v140-shape) table; an older binary's
 * 8-column INSERT still lands, leaving the new columns NULL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { v328 } from '../src/core/schema-migrations/v328-chat-usage-attribution.ts';
import { makeEngineChatUsageSink } from '../src/core/ai/chat-usage.ts';

const NEW_COLUMNS = ['kind', 'operation', 'job_id', 'job_name', 'op', 'caller', 'cli_command', 'latency_ms', 'outcome'];

describe('migration v328 — chat_usage_log attribution', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => { await engine.disconnect(); });

  const columns = async () => (await engine.executeRaw<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'chat_usage_log'`)).reduce<Record<string, string>>((m, r) => ({ ...m, [r.column_name]: r.data_type }), {});

  test('columns and the job index exist after initSchema', async () => {
    const cols = await columns();
    for (const c of NEW_COLUMNS) expect(cols[c]).toBeDefined();
    expect(cols.job_id).toBe('bigint');
    expect(cols.latency_ms).toBe('integer');
    expect(cols.caller).toBe('text');
    const idx = await engine.executeRaw<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_chat_usage_log_job'`);
    expect(idx).toHaveLength(1);
    expect(idx[0]!.indexdef).toContain('WHERE (job_id IS NOT NULL)');
  });

  test('re-running is idempotent', async () => {
    await engine.runMigration(v328.version, v328.sql);
    await engine.runMigration(v328.version, v328.sql);
    expect((await runMigrations(engine)).applied).toBe(0);
  });

  test('a pre-v328 table gains the columns; old-shape inserts still land', async () => {
    for (const c of NEW_COLUMNS) await engine.executeRaw(`ALTER TABLE chat_usage_log DROP COLUMN IF EXISTS ${c}`);
    await engine.executeRaw(
      `INSERT INTO chat_usage_log (model, provider, phase, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, ['anthropic:claude-haiku-4-5', 'anthropic', null, 1, 1, 0, 0, null]);
    await engine.runMigration(v328.version, v328.sql);
    const cols = await columns();
    for (const c of NEW_COLUMNS) expect(cols[c]).toBeDefined();
    // The old row survives with NULL attribution; an old-shape insert still works after v328.
    await engine.executeRaw(
      `INSERT INTO chat_usage_log (model, provider, phase, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, ['anthropic:claude-haiku-4-5', 'anthropic', null, 2, 2, 0, 0, 0.1]);
    const rows = await engine.executeRaw<{ kind: string | null; job_id: number | null }>('SELECT kind, job_id FROM chat_usage_log');
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.kind === null && r.job_id === null)).toBe(true);
  });

  test('the engine sink writes every attribution column', async () => {
    await engine.executeRaw('DELETE FROM chat_usage_log');
    await makeEngineChatUsageSink(engine)({
      model: 'openai:text-embedding-3-large', provider: 'openai', phase: 'job:embed', input_tokens: 10, output_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.000001, kind: 'embedding', operation: 'gateway.embed',
      job_id: 42, job_name: 'embed', op: 'query', caller: 'agent-a', cli_command: 'jobs', latency_ms: 12, outcome: 'ok',
    });
    const [row] = await engine.executeRaw<Record<string, unknown>>(`SELECT ${NEW_COLUMNS.join(', ')} FROM chat_usage_log`);
    expect({ ...row, job_id: Number(row!.job_id) }).toEqual({ kind: 'embedding', operation: 'gateway.embed', job_id: 42, job_name: 'embed', op: 'query',
      caller: 'agent-a', cli_command: 'jobs', latency_ms: 12, outcome: 'ok' });
  });
});

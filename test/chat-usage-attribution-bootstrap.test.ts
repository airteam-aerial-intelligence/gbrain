/**
 * chat_usage_log attribution columns: no numbered migration.
 *
 * The columns (and idx_chat_usage_log_job) reach an existing brain only through
 * the idempotent forward-reference bootstrap (src/core/engine-sql/bootstrap.ts)
 * that runs on every initSchema before the schema blob replay. Pins on PGLite:
 * a brain at v327 without the columns gains all of them plus the partial job
 * index on the next initSchema; a second initSchema is a no-op; an old-shape
 * (8-column) INSERT still lands; and the engine sink falls back to the legacy
 * INSERT while the columns are missing (fail-open), then writes every column.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeEngineChatUsageSink, type ChatUsageRecord } from '../src/core/ai/chat-usage.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';
import { MIGRATIONS } from '../src/core/schema-migrations/registry.generated.ts';

const NEW_COLUMNS = ['kind', 'operation', 'job_id', 'job_name', 'op', 'caller', 'cli_command', 'latency_ms', 'outcome', 'transport', 'error_class'];
const BASE: ChatUsageRecord = {
  model: 'anthropic:claude-haiku-4-5', provider: 'anthropic', phase: null, input_tokens: 1, output_tokens: 1,
  cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null,
};

describe('chat_usage_log attribution — bootstrap only (no numbered migration)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => { await engine.disconnect(); });

  const columns = async () => (await engine.executeRaw<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'chat_usage_log'`))
    .reduce<Record<string, string>>((m, r) => ({ ...m, [r.column_name]: r.data_type }), {});
  const jobIndex = () => engine.executeRaw<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_chat_usage_log_job'`);
  const schemaVersion = async () => Number((await engine.executeRaw<{ value: string }>(`SELECT value FROM config WHERE key = 'version'`))[0]?.value);

  test('no numbered migration of our own: the brain sits at the registered latest', async () => {
    expect(MIGRATIONS.some(m => /chat_usage/.test(m.name) && m.version > 140)).toBe(false);
    expect(await schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
  });

  test('a fresh brain has every column and the partial job index', async () => {
    const cols = await columns();
    for (const c of NEW_COLUMNS) expect(cols[c]).toBeDefined();
    expect(cols.job_id).toBe('bigint');
    expect(cols.latency_ms).toBe('integer');
    expect(cols.transport).toBe('text');
    expect(cols.error_class).toBe('text');
    const idx = await jobIndex();
    expect(idx).toHaveLength(1);
    expect(idx[0]!.indexdef).toContain('WHERE (job_id IS NOT NULL)');
  });

  test('a v327 brain without the columns: legacy sink fallback, then initSchema adds them idempotently', async () => {
    await engine.executeRaw('DROP INDEX IF EXISTS idx_chat_usage_log_job');
    for (const c of NEW_COLUMNS) await engine.executeRaw(`ALTER TABLE chat_usage_log DROP COLUMN IF EXISTS ${c}`);
    await engine.executeRaw('DELETE FROM chat_usage_log');
    expect(Object.keys(await columns())).not.toContain('job_id');

    // An older binary's 8-column INSERT lands.
    await engine.executeRaw(
      `INSERT INTO chat_usage_log (model, provider, phase, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, ['anthropic:claude-haiku-4-5', 'anthropic', null, 1, 1, 0, 0, null]);
    // The new sink falls back to the legacy INSERT instead of losing the row.
    await makeEngineChatUsageSink(engine)({ ...BASE, kind: 'chat', job_id: 7, transport: 'cli', error_class: 'http_429' });
    expect(await engine.executeRaw('SELECT 1 FROM chat_usage_log')).toHaveLength(2);

    await engine.initSchema();
    const cols = await columns();
    for (const c of NEW_COLUMNS) expect(cols[c]).toBeDefined();
    expect(await jobIndex()).toHaveLength(1);
    expect(await schemaVersion()).toBe(LATEST_SCHEMA_VERSION);

    // Idempotent: a second initSchema changes nothing and old rows keep NULL attribution.
    await engine.initSchema();
    expect(Object.keys(await columns()).sort()).toEqual(Object.keys(cols).sort());
    expect(await jobIndex()).toHaveLength(1);
    const rows = await engine.executeRaw<{ kind: string | null; job_id: number | null }>('SELECT kind, job_id FROM chat_usage_log');
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.kind === null && r.job_id === null)).toBe(true);

    // Old-shape inserts still land after the bootstrap.
    await engine.executeRaw(
      `INSERT INTO chat_usage_log (model, provider, phase, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, ['anthropic:claude-haiku-4-5', 'anthropic', null, 2, 2, 0, 0, 0.1]);
    expect(await engine.executeRaw('SELECT 1 FROM chat_usage_log')).toHaveLength(3);
  }, 60_000);

  test('the engine sink writes every attribution column', async () => {
    await engine.executeRaw('DELETE FROM chat_usage_log');
    await makeEngineChatUsageSink(engine)({
      ...BASE, model: 'openai:text-embedding-3-large', provider: 'openai', phase: 'job:embed', input_tokens: 10, output_tokens: 0,
      cost_usd: 0.000001, kind: 'embedding', operation: 'gateway.embed', job_id: 42, job_name: 'embed', op: 'query',
      caller: 'agent-a', cli_command: 'jobs', latency_ms: 12, outcome: 'error', transport: 'mcp', error_class: 'http_503',
    });
    const [row] = await engine.executeRaw<Record<string, unknown>>(`SELECT ${NEW_COLUMNS.join(', ')} FROM chat_usage_log`);
    expect({ ...row, job_id: Number(row!.job_id) } as Record<string, unknown>).toEqual({ kind: 'embedding', operation: 'gateway.embed', job_id: 42, job_name: 'embed', op: 'query',
      caller: 'agent-a', cli_command: 'jobs', latency_ms: 12, outcome: 'error', transport: 'mcp', error_class: 'http_503' });
  });

  test('a sink error other than a missing attribution column still propagates', async () => {
    const sink = makeEngineChatUsageSink({ executeRaw: async () => { throw Object.assign(new Error('boom'), { code: '57P01' }); } });
    await expect(sink(BASE)).rejects.toThrow('boom');
  });
});

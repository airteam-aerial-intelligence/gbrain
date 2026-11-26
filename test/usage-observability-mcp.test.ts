/**
 * Usage observability for MCP ops and CLI commands: provider calls made by an
 * op's handler carry `op`, `caller` and `transport` (row + line); one
 * `gbrain.op` line sums them, only when the op made at least one call. A CLI
 * run's attribution scope carries the command name to every call.
 *
 * PGLite in-memory; the embedding transport is stubbed ($0).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { opCaller } from '../src/mcp/op-usage.ts';
import { setChatUsageSink, type ChatUsageRecord } from '../src/core/ai/chat-usage.ts';
import { currentAIAttribution, invokeAI, sdkInvocationUsage, withAIAttribution } from '../src/core/ai/invocation-guard.ts';
import { installUsageObservability } from '../src/core/ai/usage-observability.ts';

let engine: PGLiteEngine;
let rows: ChatUsageRecord[] = [];
let lines: Array<Record<string, any>> = [];
const origErr = process.stderr.write.bind(process.stderr);

beforeAll(async () => {
  installUsageObservability();
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await importFromContent(engine, 'notes/widget-roadmap',
    '---\ntype: note\ntitle: Widget roadmap\n---\n\nThe widget roadmap covers the next release.\n', { noEmbed: true });
}, 60_000);

afterAll(async () => { await engine?.disconnect(); }, 60_000);

beforeEach(() => {
  rows = [];
  lines = [];
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
  __setEmbedTransportForTests((async (args: { values: string[] }) => ({
    embeddings: args.values.map(() => Array.from({ length: 1536 }, () => 0.01)), usage: { tokens: 5 },
  })) as never);
  setChatUsageSink(r => { rows.push(r); });
  process.stderr.write = ((chunk: any, ...rest: any[]) => {
    const s = String(chunk);
    if (s.startsWith('{"ts"') && s.includes('"evt":"gbrain.')) {
      for (const l of s.split('\n').filter(Boolean)) lines.push(JSON.parse(l));
      return true;
    }
    return origErr(chunk, ...rest);
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = origErr;
  setChatUsageSink(null);
  __setEmbedTransportForTests(null);
  resetGateway();
});

const drain = () => new Promise(r => setTimeout(r, 10));

describe('MCP op attribution', () => {
  test('a query op attributes its embedding call and emits one gbrain.op line', async () => {
    const result = await dispatchToolCall(engine, 'query', { query: 'widget roadmap', expand: false, use_cache: false },
      { remote: true, sourceId: 'default', transport: 'stdio', mcpCaller: { client: 'test-agent' } });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    await drain();
    const emb = rows.filter(r => r.kind === 'embedding');
    expect(emb.length).toBeGreaterThanOrEqual(1);
    expect(emb[0]).toMatchObject({ op: 'query', caller: 'test-agent' });
    const call = lines.find(l => l.evt === 'gbrain.llm_call')!;
    expect(call).toMatchObject({ op: 'query', caller: 'test-agent', transport: 'stdio' });
    const ops = lines.filter(l => l.evt === 'gbrain.op');
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'query', caller: 'test-agent', transport: 'stdio', status: 'ok', severity: 'INFO' });
    expect(ops[0]!.calls).toBe(emb.length);
    expect(typeof ops[0]!.duration_ms).toBe('number');
  });

  test('an op that makes no provider call emits no gbrain.op line', async () => {
    const result = await dispatchToolCall(engine, 'get_page', { slug: 'notes/widget-roadmap' },
      { remote: true, sourceId: 'default', transport: 'stdio', mcpCaller: { client: 'test-agent' } });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    await drain();
    expect(lines.filter(l => l.evt === 'gbrain.op')).toEqual([]);
    expect(rows).toEqual([]);
  });

  test('caller is the client name, plus the end user when named', () => {
    expect(opCaller({ mcpCaller: { client: 'agent-a' } })).toBe('agent-a');
    expect(opCaller({ auth: { clientId: 'c1', clientName: 'oauth-app', scopes: [] } as never })).toBe('oauth-app');
    expect(opCaller({ mcpCaller: { client: 'agent-a' }, endUser: 'user-1' })).toBe('agent-a/user-1');
    expect(opCaller({})).toBeUndefined();
  });
});

describe('CLI attribution', () => {
  test('the command name set on the cli scope reaches every call', async () => {
    await withAIAttribution({ transport: 'cli' }, async () => {
      // What cli/main.ts does once the command is routed.
      currentAIAttribution()!.cli_command = 'query';
      await withAIAttribution({ job_name: 'nested' }, () =>
        invokeAI({ operation: 't', kind: 'chat', model: 'anthropic:claude-haiku-4-5' }, async () => ({ usage: { inputTokens: 1, outputTokens: 1 } }), sdkInvocationUsage));
    });
    await drain();
    expect(rows[0]).toMatchObject({ cli_command: 'query' });
    expect(lines.find(l => l.evt === 'gbrain.llm_call')).toMatchObject({ cli_command: 'query', transport: 'cli' });
  });
});

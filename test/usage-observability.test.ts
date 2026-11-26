/**
 * Usage observability: every provider call is attributed, logged and recorded.
 *
 * Pins: embeddings and the subagent raw-SDK path land in chat_usage_log; a
 * chat call writes exactly ONE row (no double count with recordChatUsage);
 * GBRAIN_USAGE_LOG=off silences the JSON lines but rows are still written;
 * a line carries no prompt text, key or header value; severity INFO; unknown
 * models price as null (never 0); a thrown call carries its error class only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { makeSubagentHandler, type MessagesClient } from '../src/core/minions/handlers/subagent.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  chat,
  configureGateway,
  embed,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { setChatUsageSink, type ChatUsageRecord } from '../src/core/ai/chat-usage.ts';
import { invokeAI, sdkInvocationUsage, withAIAttribution } from '../src/core/ai/invocation-guard.ts';
import {
  installUsageObservability,
  newUsageTotals,
  priceCall,
  providerOf,
  summarizeUsage,
  usageLogMode,
  withUsageScope,
} from '../src/core/ai/usage-observability.ts';
import { withEnv } from './helpers/with-env.ts';

let rows: ChatUsageRecord[] = [];
const capture = () => setChatUsageSink(r => { rows.push(r); });

/** Collect usage lines written to stderr/stdout while `fn` runs. */
async function linesOf<T>(fn: () => Promise<T>): Promise<{ lines: Array<Record<string, any>>; raw: string; result?: T; error?: unknown }> {
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  let raw = '';
  const grab = (orig: typeof origErr) => ((chunk: any, ...rest: any[]) => {
    const s = String(chunk);
    if (s.startsWith('{"ts"') && s.includes('"evt":"gbrain.')) { raw += s; return true; }
    return orig(chunk, ...rest);
  }) as typeof process.stderr.write;
  process.stderr.write = grab(origErr);
  process.stdout.write = grab(origOut);
  let result: T | undefined, error: unknown;
  try { result = await fn(); } catch (e) { error = e; }
  finally { process.stderr.write = origErr; process.stdout.write = origOut; }
  const lines = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { lines, raw, result, error };
}

function fakeResult(over: Partial<ChatResult> = {}): ChatResult {
  return {
    text: 'ok', blocks: [{ type: 'text', text: 'ok' }], stopReason: 'end',
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic', ...over,
  };
}

const drain = () => new Promise(r => setTimeout(r, 10));

beforeAll(() => { installUsageObservability(); });
afterEach(() => {
  rows = [];
  setChatUsageSink(null);
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('usage helpers', () => {
  test('GBRAIN_USAGE_LOG modes; default and unknown values are stderr', () => {
    expect(usageLogMode({})).toBe('stderr');
    expect(usageLogMode({ GBRAIN_USAGE_LOG: 'off' })).toBe('off');
    expect(usageLogMode({ GBRAIN_USAGE_LOG: 'STDOUT' })).toBe('stdout');
    expect(usageLogMode({ GBRAIN_USAGE_LOG: 'loud' })).toBe('stderr');
  });

  test('provider is the prefix; a bare id is anthropic', () => {
    expect(providerOf('openai:gpt-4o')).toBe('openai');
    expect(providerOf('claude-sonnet-4-6')).toBe('anthropic');
  });

  test('unknown model or missing usage prices as null, never 0', () => {
    const usage = { inputTokens: 100, outputTokens: 10 };
    expect(priceCall('acme:unpriced-model-9000', 'chat', usage)).toBeNull();
    expect(priceCall('anthropic:claude-haiku-4-5', 'chat', null)).toBeNull();
    expect(priceCall('acme:unpriced-embed', 'embedding', usage)).toBeNull();
    expect(priceCall('openai:text-embedding-3-small', 'embedding', { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.02, 10);
    // A bare (legacy subagent) id prices like its anthropic: form.
    expect(priceCall('claude-haiku-4-5', 'chat', usage)).toBeCloseTo(priceCall('anthropic:claude-haiku-4-5', 'chat', usage)!, 12);
  });

  test('nested usage scopes both see a call', async () => {
    const outer = newUsageTotals(), inner = newUsageTotals();
    await withUsageScope(outer, () => withUsageScope(inner, () =>
      invokeAI({ operation: 't', kind: 'chat', model: 'anthropic:claude-haiku-4-5' }, async () => ({ usage: { inputTokens: 10, outputTokens: 2 } }), sdkInvocationUsage)));
    expect(summarizeUsage(inner).calls).toBe(1);
    expect(summarizeUsage(outer).calls).toBe(1);
    expect(summarizeUsage(outer).cost_usd).toBeGreaterThan(0);
  });
});

describe('every provider call is recorded', () => {
  test('a gateway.chat call writes exactly one row and one line', async () => {
    capture();
    __setChatTransportForTests(async () => fakeResult());
    const { lines } = await linesOf(() => chat({ model: 'anthropic:claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }));
    await drain();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'chat', operation: 'gateway.chat', outcome: 'ok', input_tokens: 1000, output_tokens: 500 });
    const calls = lines.filter(l => l.evt === 'gbrain.llm_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ severity: 'INFO', provider: 'anthropic', model: 'anthropic:claude-haiku-4-5', kind: 'chat', outcome: 'ok', input_tokens: 1000, output_tokens: 500, error_class: null });
    expect(calls[0]!.cost_usd).toBeCloseTo(0.0035, 8);
    expect(typeof calls[0]!.ts).toBe('string');
    expect(typeof calls[0]!.latency_ms).toBe('number');
  });

  test('an embedding call is recorded with kind embedding and a price', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 8, env: { OPENAI_API_KEY: 'sk-fake' } });
    __setEmbedTransportForTests((async (args: { values: string[] }) => ({ embeddings: args.values.map(() => Array.from({ length: 8 }, () => 0.1)), usage: { tokens: 1000 } })) as never);
    capture();
    await linesOf(() => embed(['alpha', 'beta']));
    await drain();
    const emb = rows.filter(r => r.kind === 'embedding');
    expect(emb.length).toBeGreaterThanOrEqual(1);
    expect(emb[0]).toMatchObject({ model: 'openai:text-embedding-3-large', provider: 'openai', operation: 'gateway.embed', outcome: 'ok', input_tokens: 1000 });
    expect(emb[0]!.cost_usd).toBeCloseTo(1000 * 0.13 / 1e6, 12);
  });

  test('GBRAIN_USAGE_LOG=off silences lines; the row is still written', async () => {
    capture();
    __setChatTransportForTests(async () => fakeResult());
    const { lines } = await withEnv({ GBRAIN_USAGE_LOG: 'off' }, () =>
      linesOf(() => chat({ model: 'anthropic:claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] })));
    await drain();
    expect(lines).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  test('GBRAIN_USAGE_LOG=stdout writes the line to stdout', async () => {
    const origOut = process.stdout.write.bind(process.stdout);
    let out = '';
    process.stdout.write = ((c: any, ...r: any[]) => { const s = String(c); if (s.includes('gbrain.llm_call')) { out += s; return true; } return origOut(c, ...r); }) as typeof process.stdout.write;
    try {
      await withEnv({ GBRAIN_USAGE_LOG: 'stdout' }, () =>
        invokeAI({ operation: 't', kind: 'chat', model: 'anthropic:claude-haiku-4-5' }, async () => ({ usage: { inputTokens: 1, outputTokens: 1 } }), sdkInvocationUsage));
    } finally { process.stdout.write = origOut; }
    expect(JSON.parse(out.trim()).evt).toBe('gbrain.llm_call');
  });

  test('a line carries no prompt text, key or header value; a thrown call carries only its error class', async () => {
    class ProviderExplodedError extends Error {}
    const SENTINEL = 'SENTINEL-7f3a9';
    capture();
    configureGateway({ env: { ANTHROPIC_API_KEY: `sk-ant-${SENTINEL}-key` } });
    __setChatTransportForTests(async () => { throw new ProviderExplodedError(`upstream said ${SENTINEL} x-api-key: sk-ant-${SENTINEL}`); });
    const { lines, raw, error } = await linesOf(() => chat({ model: 'anthropic:claude-haiku-4-5', messages: [{ role: 'user', content: `prompt ${SENTINEL}` }] }));
    await drain();
    expect(error).toBeInstanceOf(ProviderExplodedError);
    expect(raw).not.toContain(SENTINEL);
    const call = lines.find(l => l.evt === 'gbrain.llm_call')!;
    expect(call).toMatchObject({ outcome: 'error', error_class: 'ProviderExplodedError', input_tokens: null, cost_usd: null, severity: 'INFO' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'error', input_tokens: 0, cost_usd: null });
    expect(JSON.stringify(rows[0])).not.toContain(SENTINEL);
  });

  test('an unknown model records cost null (never 0)', async () => {
    capture();
    const { lines } = await linesOf(() => invokeAI({ operation: 't', kind: 'chat', model: 'acme:unpriced-model-9000' },
      async () => ({ usage: { inputTokens: 10, outputTokens: 5 } }), sdkInvocationUsage));
    await drain();
    expect(rows[0]!.cost_usd).toBeNull();
    expect(lines[0]!.cost_usd).toBeNull();
  });

  test('a claude-cli model is observed and prices through its anthropic sibling', async () => {
    capture();
    const { lines } = await linesOf(() => invokeAI({ operation: 'gateway.chat', kind: 'chat', model: 'claude-cli:claude-haiku-4-5' },
      async () => ({ usage: { inputTokens: 1000, outputTokens: 500 } }), sdkInvocationUsage));
    await drain();
    expect(rows[0]).toMatchObject({ model: 'claude-cli:claude-haiku-4-5', provider: 'claude-cli' });
    expect(lines[0]!.provider).toBe('claude-cli');
  });
});

describe('subagent raw-SDK path (subagent_legacy)', () => {
  let engine: PGLiteEngine;
  let queue: MinionQueue;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
    queue = new MinionQueue(engine);
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); });

  test('a subagent turn is recorded with its job attribution', async () => {
    const client: MessagesClient = {
      async create(params: any) {
        return { id: 'msg_1', type: 'message', role: 'assistant', model: params.model, stop_reason: 'end_turn', stop_sequence: null,
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any;
      },
    };
    const job = await queue.add('subagent', { prompt: 'finish', allowed_tools: [] }, {}, { allowProtectedSubmit: true });
    const ac = new AbortController();
    const ctx: MinionJobContext = {
      id: job.id, name: job.name, data: { prompt: 'finish', allowed_tools: [] }, attempts_made: 0, idempotency_key: null,
      signal: ac.signal, deadlineAtMs: null, shutdownSignal: new AbortController().signal,
      async updateProgress() {}, async updateTokens() {}, async log() {}, async isActive() { return true; }, async readInbox() { return []; },
    };
    capture();
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [] });
    const { lines } = await linesOf(() => withAIAttribution({ job_id: job.id, job_name: job.name }, () => handler(ctx)));
    await drain();
    const sub = rows.filter(r => r.operation === 'subagent_legacy');
    expect(sub).toHaveLength(1);
    expect(sub[0]).toMatchObject({ kind: 'chat', provider: 'anthropic', outcome: 'ok', job_id: job.id, job_name: 'subagent', output_tokens: 5 });
    expect(sub[0]!.cost_usd).not.toBeNull();
    expect(lines.find(l => l.operation === 'subagent_legacy')).toMatchObject({ job_id: job.id, job_name: 'subagent' });
  });
});

describe('review fixes', () => {
  test('GBRAIN_USAGE_LOG=stdout under stdio serve (stdout redirected) writes to stderr, never the JSON-RPC stream', async () => {
    const { redirectStdoutLoggingToStderr, _resetStdoutRedirectForTests } = await import('../src/core/console-prefix.ts');
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    let out = '', err = '';
    process.stdout.write = ((c: any, ...r: any[]) => { const s = String(c); if (s.includes('gbrain.llm_call')) { out += s; return true; } return origOut(c, ...r); }) as typeof process.stdout.write;
    process.stderr.write = ((c: any, ...r: any[]) => { const s = String(c); if (s.includes('gbrain.llm_call')) { err += s; return true; } return origErr(c, ...r); }) as typeof process.stderr.write;
    redirectStdoutLoggingToStderr();
    try {
      await withEnv({ GBRAIN_USAGE_LOG: 'stdout' }, () =>
        invokeAI({ operation: 't', kind: 'chat', model: 'anthropic:claude-haiku-4-5' }, async () => ({ usage: { inputTokens: 1, outputTokens: 1 } }), sdkInvocationUsage));
    } finally {
      _resetStdoutRedirectForTests();
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    expect(out).toBe('');
    expect(JSON.parse(err.trim()).evt).toBe('gbrain.llm_call');
  });

  test('a fetch-based call resolving with HTTP 429 is observed as outcome error, error_class http_429; the Response is still returned', async () => {
    capture();
    const response = new Response('slow down', { status: 429 });
    const { lines, result } = await linesOf(() => invokeAI({ operation: 'gateway.rerank', kind: 'rerank', model: 'voyage:rerank-2' },
      async () => response, () => null));
    await drain();
    expect(result).toBe(response);
    expect(lines[0]).toMatchObject({ outcome: 'error', error_class: 'http_429' });
    expect(rows[0]).toMatchObject({ outcome: 'error', error_class: 'http_429' });
  });

  test('an ok Response stays outcome ok with no error_class', async () => {
    capture();
    const { lines } = await linesOf(() => invokeAI({ operation: 'gateway.rerank', kind: 'rerank', model: 'voyage:rerank-2' },
      async () => new Response('{}', { status: 200 }), () => null));
    await drain();
    expect(lines[0]).toMatchObject({ outcome: 'ok', error_class: null });
    expect(rows[0]).toMatchObject({ outcome: 'ok', error_class: null });
  });

  test('row and line agree on phase (attribution phase wins) and the row carries transport', async () => {
    capture();
    const { withChatPhase } = await import('../src/core/ai/chat-usage.ts');
    const { lines } = await linesOf(() => withChatPhase('phase:outer', () => withAIAttribution({ phase: 'attr-phase', transport: 'mcp' }, () =>
      invokeAI({ operation: 't', kind: 'chat', model: 'anthropic:claude-haiku-4-5' }, async () => ({ usage: { inputTokens: 1, outputTokens: 1 } }), sdkInvocationUsage))));
    await drain();
    expect(lines[0]).toMatchObject({ phase: 'attr-phase', transport: 'mcp' });
    expect(rows[0]).toMatchObject({ phase: 'attr-phase', transport: 'mcp' });
  });
});

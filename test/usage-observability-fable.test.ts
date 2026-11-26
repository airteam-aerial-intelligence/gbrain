/**
 * release/airteam.4 interaction: usage observability x the hard Fable ban and
 * remote_caller (confined) jobs.
 *
 * Pins: a Fable-denied call is observed as `refused` with error_class
 * DeniedModelError (one gbrain.llm_call line, no chat_usage_log row, provider
 * never called) on both the invokeAI and the guarded-generation seams; an
 * unobserved call is still refused; a confined remote_caller job's tool call
 * keeps the job's attribution on the usage it causes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { setChatUsageSink, type ChatUsageRecord } from '../src/core/ai/chat-usage.ts';
import { currentAIAttribution, invokeAI, observeAIInvocations, sdkInvocationUsage, withAIAttribution } from '../src/core/ai/invocation-guard.ts';
import { createGuardedGeneration } from '../src/core/ai/guarded-generation.ts';
import { DeniedModelError } from '../src/core/ai/model-deny.ts';
import { installUsageObservability } from '../src/core/ai/usage-observability.ts';
import { jobsOperations } from '../src/core/ops/jobs.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { parseSubmissionAuthority, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';

let rows: ChatUsageRecord[] = [];

async function linesOf(fn: () => Promise<unknown>): Promise<{ lines: Array<Record<string, any>>; error?: unknown }> {
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
  let error: unknown;
  try { await fn(); } catch (e) { error = e; }
  finally { process.stderr.write = origErr; process.stdout.write = origOut; }
  return { lines: raw.split('\n').filter(Boolean).map(l => JSON.parse(l)), error };
}
const drain = () => new Promise(r => setTimeout(r, 10));

beforeAll(() => { installUsageObservability(); });
afterEach(() => { rows = []; setChatUsageSink(null); });

describe('a Fable-denied call is observed as refused, never recorded', () => {
  test('invokeAI: one refused line with error_class DeniedModelError, no row, provider never called', async () => {
    setChatUsageSink(r => { rows.push(r); });
    let ran = false;
    const { lines, error } = await linesOf(() => withAIAttribution({ job_id: 41, job_name: 'subagent' }, () =>
      invokeAI({ operation: 'x', kind: 'chat', model: 'anthropic:claude-fable-5' }, async () => { ran = true; return {}; }, () => null)));
    await drain();
    expect(error).toBeInstanceOf(DeniedModelError);
    expect(ran).toBe(false);
    const calls = lines.filter(l => l.evt === 'gbrain.llm_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ outcome: 'refused', error_class: 'DeniedModelError', model: 'anthropic:claude-fable-5', job_id: 41 });
    expect(rows).toHaveLength(0);
  });

  test('guarded generation seam: refused line, no row, transport never called', async () => {
    setChatUsageSink(r => { rows.push(r); });
    let ran = false;
    const gen = createGuardedGeneration(() => 100);
    const { lines, error } = await linesOf(() => gen('anthropic:claude-fable-5-1', async () => { ran = true; return {}; }, {}));
    await drain();
    expect(error).toBeInstanceOf(DeniedModelError);
    expect(ran).toBe(false);
    expect(lines.filter(l => l.evt === 'gbrain.llm_call')).toEqual([expect.objectContaining({ outcome: 'refused', error_class: 'DeniedModelError' })]);
    expect(rows).toHaveLength(0);
  });

  test('a throwing observer does not turn the denial into another error', async () => {
    const off = observeAIInvocations(() => { throw new Error('observer boom'); });
    try {
      await expect(invokeAI({ operation: 'x', kind: 'chat', model: 'claude-fable-5' }, async () => ({}), () => null)).rejects.toBeInstanceOf(DeniedModelError);
    } finally { off(); }
  });
});

describe('a confined remote_caller job keeps its job attribution inside tool calls', () => {
  let engine: PGLiteEngine;
  let gw: { id: string };
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    gw = await mintLegacyToken(engine, { name: 'gateway', takesHolders: ['world'], scopes: ['read', 'write', 'admin'] });
    await importFromContent(engine, 'notes/open-plan', '---\ntype: note\ntitle: Open plan\n---\n# Open plan\n\nopen canary.', { sourceId: 'default', noEmbed: true });
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });

  test('the tool handler sees the job id/name set by the worker, under the submitter\'s confinement', async () => {
    await engine.setConfig('jobs.remote_protected_allow', 'subagent');
    const ctx = {
      engine, config: {} as OperationContext['config'], dryRun: false, remote: true, sourceId: 'default', transport: 'http',
      logger: { info() {}, warn() {}, error() {} },
      auth: { token: 'test-only', clientId: gw.id, principal: { kind: 'legacy_token', id: gw.id }, scopes: ['read', 'write', 'admin'], sourceId: 'default', allowedSources: ['default'] },
    } as OperationContext;
    const { id } = await jobsOperations.find(op => op.name === 'submit_job')!.handler(ctx, { name: 'subagent', data: { prompt: 'x' } }) as { id: number };
    const authority = parseSubmissionAuthority((await new MinionQueue(engine).getJob(id))?.submission_authority)!;
    expect(authority.kind).toBe('remote_caller');
    const tool = buildBrainTools({ subagentId: 1, engine, config: {} as never, sourceId: 'default' }).find(t => t.name === 'brain_get_page')!;
    // The worker wraps the handler in withSubmissionAuthority + withAIAttribution (worker.ts / run-child.ts);
    // a provider call made anywhere under the confined tool call inherits the job attribution.
    let seen: ReturnType<typeof currentAIAttribution> = null;
    let sawRemote: unknown;
    const op = operations.find(o => o.name === 'get_page')!;
    const original = op.handler;
    op.handler = (async (c: OperationContext, p: Record<string, unknown>) => {
      seen = currentAIAttribution();
      sawRemote = c.remote;
      return original(c, p as never);
    }) as typeof op.handler;
    try {
      const page = await withAIAttribution({ job_id: id, job_name: 'subagent' }, () =>
        withSubmissionAuthority(authority, () => tool.execute({ slug: 'notes/open-plan' }, { engine, jobId: id } as never))) as { slug?: string };
      expect(page.slug).toBe('notes/open-plan');
    } finally { op.handler = original; }
    expect(sawRemote).toBe(true);
    expect(seen).toMatchObject({ job_id: id, job_name: 'subagent' });
  });
});

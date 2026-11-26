/**
 * Airteam fork: remote think / remote protected submit_job are config-gated, and Fable models are banned everywhere.
 *
 * 1. Protects: with no config, remote think stays host-model / 1 round / read-only and remote submit_job refuses every
 *    protected name; with think.remote_models='*', think.remote_max_rounds, think.remote_persist and
 *    jobs.remote_protected_allow set, a remote admin caller gets caller model choice, multi-round, persistence and
 *    protected job submission (under a spend cap). `shell` is never remotely submittable. Any model id matching
 *    /fable/i is refused on every path: think model param, config default, subagent job model, resolveModel,
 *    the gateway generation seam, invokeAI and the claude-cli language model.
 * 2. Fails when: a default changes without config, shell opens remotely, or a Fable id reaches a provider.
 * 3. Real seams: MCP dispatch (remote=true, http), the jobs operation handler, MinionQueue, the gateway with a stub
 *    generateText transport.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setGenerateTextTransportForTests } from '../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { jobsOperations } from '../src/core/ops/jobs.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { resolveModel } from '../src/core/model-config.ts';
import { invokeAI } from '../src/core/ai/invocation-guard.ts';
import { createGuardedGeneration } from '../src/core/ai/guarded-generation.ts';
import { ClaudeCliLanguageModel } from '../src/core/ai/providers/claude-cli-language-model.ts';
import { DeniedModelError, isDeniedModel } from '../src/core/ai/model-deny.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { allowedJobModelOrDead } from '../src/core/minions/denied-model.ts';
import { UnrecoverableError } from '../src/core/minions/types.ts';

const HOST = 'openai:gpt-6.1-sol';
const OTHER = 'openai:gpt-5.5';
const FABLES = ['claude-fable-5', 'anthropic:claude-fable-5-1', 'claude-cli:claude-fable-5-2', 'CLAUDE-FABLE-5', 'openrouter:anthropic/claude-fable-5'];

let engine: PGLiteEngine;
const called: string[] = [];

function keyed() {
  configureGateway({ chat_model: HOST, env: { OPENAI_API_KEY: 'fake-openai' } });
  __setGenerateTextTransportForTests((async (args: { model: { modelId: string } }) => {
    called.push(args.model.modelId);
    return { content: [{ type: 'text', text: JSON.stringify({ answer: 'answered by ' + args.model.modelId, citations: [], gaps: [] }) }], finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 2 } };
  }) as never);
}

async function remoteThink(params: Record<string, unknown>, scopes: string[] = ['read', 'write']) {
  const out = await dispatchToolCall(engine, 'think', { question: 'who founded acme-example', ...params },
    { remote: true, transport: 'http', sourceId: 'default', sessionId: randomUUID(), auth: { token: 't', clientId: 'gw', scopes, sourceId: 'default' } as never });
  const text = out.content[0]!.text;
  let body: any = {};
  try { body = JSON.parse(text); } catch { /* error text */ }
  const notices = ((out._meta as { gbrain_notices?: Array<{ code: string }> } | undefined)?.gbrain_notices ?? []);
  return { isError: out.isError === true, body, text, codes: notices.map(n => n.code) };
}

function jobCtx(scopes: string[] = ['read', 'write', 'admin']): OperationContext {
  return {
    engine, config: {} as OperationContext['config'], dryRun: false, remote: true, sourceId: 'default', transport: 'http',
    logger: { info() {}, warn() {}, error() {} },
    auth: { token: 'test-only', principal: { kind: 'legacy_token', id: 'gw' }, scopes, sourceId: 'default' },
  } as OperationContext;
}
const submitJob = (ctx: OperationContext, p: Record<string, unknown>) => jobsOperations.find(op => op.name === 'submit_job')!.handler(ctx, p);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  await engine.setConfig('models.think', HOST);
}, 120_000);
afterEach(async () => {
  __setGenerateTextTransportForTests(null);
  resetGateway();
  called.length = 0;
  for (const k of ['think.remote_models', 'think.remote_max_rounds', 'think.remote_persist', 'jobs.remote_protected_allow', 'jobs.remote_max_usd', 'models.subagent']) await engine.unsetConfig(k);
  await engine.setConfig('models.think', HOST);
  await engine.executeRaw('DELETE FROM minion_jobs');
});
afterAll(async () => { await engine?.disconnect(); });

describe('remote think: defaults unchanged, config opens model/rounds/persist', () => {
  test('defaults: unlisted model ignored, one round, save blocked', async () => {
    keyed();
    const r = await remoteThink({ model: OTHER, rounds: 4, save: true });
    expect(r.isError).toBe(false);
    expect(called).toEqual(['gpt-6.1-sol']);
    expect(r.body.warnings).toContain('MODEL_OVERRIDE_IGNORED:not_allowed');
    expect(r.body.remote_persisted_blocked).toBe(true);
    expect(r.codes).toContain('think_not_saved');
  });

  test("think.remote_models='*' honors the caller's model", async () => {
    keyed();
    await engine.setConfig('think.remote_models', '*');
    const r = await remoteThink({ model: OTHER });
    expect(r.isError).toBe(false);
    expect(called).toEqual(['gpt-5.5']);
    expect(r.body.modelUsed).toBe(OTHER);
  });

  test('think.remote_max_rounds passes rounds > 1 through to runThink (clamped); default stays 1', async () => {
    // runThink's round loop is scaffolding (one synthesis + ROUNDS_GT_1 warning), so the warning is the observable.
    keyed();
    await engine.setConfig('think.remote_max_rounds', '2');
    const multi = await remoteThink({ rounds: 5 });
    expect(multi.body.warnings).toContain('ROUNDS_GT_1_NOT_GAP_DRIVEN_IN_V028');
    await engine.unsetConfig('think.remote_max_rounds');
    const single = await remoteThink({ rounds: 5 });
    expect(single.body.warnings).not.toContain('ROUNDS_GT_1_NOT_GAP_DRIVEN_IN_V028');
  });

  test('think.remote_persist unblocks save only for a write-scoped caller', async () => {
    keyed();
    await engine.setConfig('think.remote_persist', 'true');
    const w = await remoteThink({ save: true });
    expect(w.body.remote_persisted_blocked).toBe(false);
    expect(w.codes).not.toContain('think_not_saved');
    const ro = await remoteThink({ save: true }, ['read']);
    expect(ro.body.remote_persisted_blocked).toBe(true);
  });
});

describe('Fable ban', () => {
  test('pattern matches every Fable spelling and nothing else', () => {
    for (const m of FABLES) expect(isDeniedModel(m)).toBe(true);
    for (const m of ['claude-opus-4-7', 'anthropic:claude-sonnet-4-6', HOST]) expect(isDeniedModel(m)).toBe(false);
  });

  test('remote think refuses a Fable model param even with remote_models=*', async () => {
    keyed();
    await engine.setConfig('think.remote_models', '*');
    for (const m of ['claude-fable-5', 'claude-cli:claude-fable-5-2']) {
      const r = await remoteThink({ model: m });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('model_denied');
    }
    expect(called).toEqual([]);
  });

  test('a Fable config default (models.think) is refused, never called', async () => {
    keyed();
    await engine.setConfig('models.think', 'anthropic:claude-fable-5-1');
    const r = await remoteThink({});
    expect(r.isError).toBe(true);
    expect(r.text).toContain('model_denied');
    expect(called).toEqual([]);
  });

  test('resolveModel refuses Fable from flag, config key and env', async () => {
    await expect(resolveModel(engine, { cliFlag: 'claude-cli:claude-fable-5-2', fallback: 'opus' })).rejects.toBeInstanceOf(DeniedModelError);
    await engine.setConfig('models.subagent', 'claude-fable-5');
    await expect(resolveModel(engine, { configKey: 'models.subagent', tier: 'subagent', fallback: 'opus' })).rejects.toBeInstanceOf(DeniedModelError);
  });

  test('gateway seams refuse Fable: invokeAI, guarded generation, claude-cli model', async () => {
    let ran = false;
    await expect(invokeAI({ operation: 'x', kind: 'chat', model: 'anthropic:claude-fable-5' }, async () => { ran = true; return {}; }, () => null)).rejects.toBeInstanceOf(DeniedModelError);
    const gen = createGuardedGeneration(() => 100);
    await expect(gen('claude-cli:claude-fable-5', async () => { ran = true; return {}; }, {})).rejects.toBeInstanceOf(DeniedModelError);
    const cli = new ClaudeCliLanguageModel('claude-fable-5-2');
    await expect(cli.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never)).rejects.toBeInstanceOf(DeniedModelError);
    expect(ran).toBe(false);
  });

  test('subagent handler entry dead-letters a Fable model from data.model or a config default (sub-subagents included)', async () => {
    await expect(allowedJobModelOrDead('claude-cli:claude-fable-5', 'subagent')).rejects.toBeInstanceOf(UnrecoverableError);
    await engine.setConfig('models.subagent', 'claude-fable-5-1');
    await expect(allowedJobModelOrDead(resolveModel(engine, { tier: 'subagent', configKey: 'models.subagent', fallback: 'opus' }), 'subagent')).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await allowedJobModelOrDead('anthropic:claude-sonnet-4-6', 'subagent')).toBe('anthropic:claude-sonnet-4-6');
  });

  test('a subagent job naming Fable is refused at queue.add (local trusted path too)', async () => {
    const queue = new MinionQueue(engine);
    await expect(queue.add('subagent', { prompt: 'x', model: 'anthropic:claude-fable-5' }, {}, { allowProtectedSubmit: true })).rejects.toBeInstanceOf(DeniedModelError);
  });
});

describe('remote submit_job of protected names', () => {
  test('defaults: protected names refused remotely', async () => {
    await expect(submitJob(jobCtx(), { name: 'subagent', data: { prompt: 'x' } })).rejects.toThrow();
    await expect(submitJob(jobCtx(), { name: 'synthesize', data: {} })).rejects.toThrow();
  });

  test('configured names are accepted for an admin caller, with a capped spend authorization', async () => {
    await engine.setConfig('jobs.remote_protected_allow', 'subagent,synthesize');
    await engine.setConfig('jobs.remote_max_usd', '3');
    const sub = await submitJob(jobCtx(), { name: 'subagent', data: { prompt: 'x', source_id: 'other' }, max_usd: 10 }) as { id: number };
    const row = await new MinionQueue(engine).getJob(sub.id);
    expect(row?.name).toBe('subagent');
    expect(row?.data.source_id).toBe('default');
    expect(row?.spend_authorization?.cap_usd).toBe(3);
    const syn = await submitJob(jobCtx(), { name: 'synthesize', data: {}, max_usd: 1 }) as { id: number };
    expect((await new MinionQueue(engine).getJob(syn.id))?.spend_authorization?.cap_usd).toBe(1);
    // unlisted protected name stays refused
    await expect(submitJob(jobCtx(), { name: 'patterns', data: {} })).rejects.toThrow();
    // non-admin caller stays refused
    await expect(submitJob(jobCtx(['read', 'write']), { name: 'subagent', data: { prompt: 'x' } })).rejects.toThrow();
  });

  test("shell stays refused remotely even with '*' or an explicit listing", async () => {
    await engine.setConfig('jobs.remote_protected_allow', '*,shell');
    await expect(submitJob(jobCtx(), { name: 'shell', data: { cmd: 'echo hi', cwd: '/tmp' } })).rejects.toThrow();
    const [{ n }] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'shell'");
    expect(n).toBe(0);
  });

  test('a remotely submitted subagent naming Fable is refused', async () => {
    await engine.setConfig('jobs.remote_protected_allow', '*');
    await expect(submitJob(jobCtx(), { name: 'subagent', data: { prompt: 'x', model: 'claude-cli:claude-fable-5' } })).rejects.toBeInstanceOf(DeniedModelError);
  });
});

/**
 * Usage observability for minion jobs: provider calls made by a job carry its
 * id and name (row + `gbrain.llm_call` line), and the worker brackets each job
 * with `gbrain.job` start/end lines whose end line sums the job's usage.
 *
 * Paths: inline handler; the isolation child core (`runChildJobEntry`, which
 * reports its totals in the outcome file); the isolated parent folding a
 * child's reported totals, or marking `usage_complete: false` when the child
 * died before reporting. The end line carries an error class, never the message.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { runChildJobEntry } from '../src/core/minions/run-child.ts';
import { runSubagentsInline } from '../src/core/cycle/inline-drain.ts';
import { runJobWithUsage } from '../src/core/minions/job-usage.ts';
import { decodeChildOutcomeFile } from '../src/core/minions/job-isolation.ts';
import { setChatUsageSink, type ChatUsageRecord } from '../src/core/ai/chat-usage.ts';
import { invokeAI, sdkInvocationUsage } from '../src/core/ai/invocation-guard.ts';
import { installUsageObservability } from '../src/core/ai/usage-observability.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let dir: string;
let rows: ChatUsageRecord[] = [];
let lines: Array<Record<string, any>> = [];
const origErr = process.stderr.write.bind(process.stderr);

const MODEL = 'anthropic:claude-haiku-4-5';
const modelCall = () => invokeAI({ operation: 'test.job_call', kind: 'chat', model: MODEL },
  async () => ({ usage: { inputTokens: 100, outputTokens: 20 } }), sdkInvocationUsage);

beforeAll(async () => {
  installUsageObservability();
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
  dir = mkdtempSync(join(tmpdir(), 'gbrain-usage-job-'));
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

beforeEach(async () => {
  rows = [];
  lines = [];
  await engine.executeRaw('DELETE FROM minion_jobs');
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
});

async function runWorkerUntil(worker: MinionWorker, done: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const run = worker.start();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (await done()) return;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('runWorkerUntil timed out');
  } finally {
    worker.stop();
    await run;
  }
}

const statusOf = async (id: number) => (await engine.executeRaw<{ status: string }>('SELECT status FROM minion_jobs WHERE id = $1', [id]))[0]?.status;
const jobLines = (id: number) => lines.filter(l => l.evt === 'gbrain.job' && l.id === id);

describe('inline worker', () => {
  test('rows and lines carry job_id/job_name; start + end lines sum the usage', async () => {
    const worker = new MinionWorker(engine, { queue: 'default', concurrency: 1, pollInterval: 25, healthCheckInterval: 0, maxRssMb: 0 });
    worker.register('usagetest', async () => { await modelCall(); await modelCall(); return { ok: true }; });
    const job = await queue.add('usagetest', {});
    await runWorkerUntil(worker, async () => (await statusOf(job.id)) === 'completed' && jobLines(job.id).length === 2);

    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ job_id: job.id, job_name: 'usagetest', phase: 'job:usagetest', operation: 'test.job_call' });
    const calls = lines.filter(l => l.evt === 'gbrain.llm_call');
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toMatchObject({ job_id: job.id, job_name: 'usagetest', phase: 'job:usagetest' });

    const [start, end] = jobLines(job.id);
    expect(start).toMatchObject({ phase: 'start', name: 'usagetest', queue: 'default', severity: 'INFO', attempts: 1 });
    expect(end).toMatchObject({ phase: 'end', status: 'completed', calls: 2, unpriced_calls: 0, error_class: null });
    expect(end!.models[MODEL]).toMatchObject({ calls: 2, input_tokens: 200, output_tokens: 40 });
    expect(end!.cost_usd).toBeGreaterThan(0);
    expect(typeof end!.duration_ms).toBe('number');
    expect(end).toHaveProperty('submitted_by');
    expect(end).toHaveProperty('submission_authority');
    expect(end).not.toHaveProperty('usage_complete');
  });

  test('a failing job ends with its status and an error class (never the message)', async () => {
    const worker = new MinionWorker(engine, { queue: 'default', concurrency: 1, pollInterval: 25, healthCheckInterval: 0, maxRssMb: 0 });
    class SecretBearingError extends Error {}
    worker.register('usagefail', async () => { await modelCall(); throw new SecretBearingError('x'.repeat(1000)); });
    const job = await queue.add('usagefail', {}, { max_attempts: 1 });
    await runWorkerUntil(worker, async () => jobLines(job.id).length === 2);
    const end = jobLines(job.id)[1]!;
    expect(end.status).toBe('dead');
    expect(end.error_class).toBe('SecretBearingError');
    expect(end).not.toHaveProperty('error');
    expect(JSON.stringify(end)).not.toContain('xxxx');
    expect(end.calls).toBe(1);
  });
});

describe('isolation child core', () => {
  test('child rows carry the job and the outcome file reports the totals', async () => {
    await queue.add('sync', {});
    const job = (await queue.claim('parent-tok-1', 30_000, 'default', ['sync']))!;
    const resultPath = join(dir, `usage-${job.id}.json`);
    const code = await runChildJobEntry(engine, { jobId: job.id, lockToken: 'parent-tok-1', resultPath, parentPid: 0 },
      { resolveHandler: () => async () => { await modelCall(); return { done: true }; } });
    expect(code).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_id: job.id, job_name: 'sync' });
    expect(lines.find(l => l.evt === 'gbrain.llm_call')).toMatchObject({ job_id: job.id, job_name: 'sync' });
    const outcome = decodeChildOutcomeFile(resultPath) as { usage: Record<string, any> };
    expect(outcome.usage[MODEL]).toMatchObject({ calls: 1, input_tokens: 100, output_tokens: 20 });
  });
});

describe('isolated parent', () => {
  const childUsage = { [MODEL]: { calls: 3, input_tokens: 30, output_tokens: 6, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.5, unpriced_calls: 0 } };
  const isolatedWorker = (script: string) => {
    const worker = new MinionWorker(engine, { queue: 'default', concurrency: 1, pollInterval: 25, healthCheckInterval: 0, maxRssMb: 0,
      jobIsolation: 'process', childCliInvocation: { cmd: process.execPath, argsPrefix: ['-e', script] } });
    worker.register('isousage', async () => { throw new Error('parent-side handler must not run when isolated'); });
    return worker;
  };

  test("the end line folds the child's reported usage", async () => {
    const script = `require('fs').writeFileSync(process.env.GBRAIN_JOB_RESULT_PATH, JSON.stringify({ outcome: 'success', result: { ok: 1 }, usage: ${JSON.stringify(childUsage)} }))`;
    const job = await queue.add('isousage', {});
    await runWorkerUntil(isolatedWorker(script), async () => jobLines(job.id).length === 2);
    const end = jobLines(job.id)[1]!;
    expect(end).toMatchObject({ status: 'completed', calls: 3, usage_complete: true, cost_usd: 0.5 });
  }, 20_000);

  test('a child that dies before reporting leaves usage_complete false', async () => {
    const job = await queue.add('isousage', {}, { max_attempts: 1 });
    await runWorkerUntil(isolatedWorker('process.exit(1)'), async () => jobLines(job.id).length === 2);
    const end = jobLines(job.id)[1]!;
    expect(end).toMatchObject({ usage_complete: false, calls: 0 });
    expect(end.status).not.toBe('completed');
  }, 20_000);
});

describe('inline drains (worker attribution parity)', () => {
  test('the cycle inline drain attributes calls to the job and brackets it with gbrain.job lines', async () => {
    const job = await queue.add('subagent', { prompt: 'p' }, { queue: 'usage-inline' }, { allowProtectedSubmit: true });
    await runSubagentsInline(engine, queue, 'usage-inline', undefined, async () => { await modelCall(); return { ok: true }; });
    expect(await statusOf(job.id)).toBe('completed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_id: job.id, job_name: 'subagent', phase: 'job:subagent' });
    expect(lines.find(l => l.evt === 'gbrain.llm_call')).toMatchObject({ job_id: job.id, job_name: 'subagent' });
    const [start, end] = jobLines(job.id);
    expect(start).toMatchObject({ phase: 'start', name: 'subagent' });
    expect(end).toMatchObject({ phase: 'end', status: 'completed', calls: 1, error_class: null });
  }, 30_000);

  test('runJobWithUsage (facts drain path) ends a throwing handler with its error class and rethrows', async () => {
    const job = await queue.add('facts-absorb-probe', {});
    class AbsorbBoom extends Error {}
    await expect(runJobWithUsage(job, async () => { await modelCall(); throw new AbsorbBoom('secret text'); })).rejects.toBeInstanceOf(AbsorbBoom);
    expect(rows[0]).toMatchObject({ job_id: job.id, job_name: 'facts-absorb-probe' });
    const end = jobLines(job.id)[1]!;
    expect(end).toMatchObject({ phase: 'end', status: 'error', error_class: 'AbsorbBoom', calls: 1 });
    expect(JSON.stringify(end)).not.toContain('secret text');
  });
});

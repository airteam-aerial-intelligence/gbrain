/**
 * job-usage.ts — per-job provider usage and the `gbrain.job` start/end lines.
 *
 * The worker opens a usage scope per job (`withUsageScope`), so every provider
 * call the handler makes adds to the job's totals; a process-isolated child
 * reports its own totals back through the outcome file (`mergeChildJobUsage`).
 * A child that died before reporting leaves `usage_complete: false`.
 * Lines go through `emitUsageLine` (GBRAIN_USAGE_LOG); never payload text and
 * never an error message: the end line carries an error class only.
 */

import type { MinionJob } from './types.ts';
import { emitUsageLine, mergeUsageTotals, newUsageTotals, summarizeUsage, usageTotalsFromJSON, withUsageScope, type UsageTotals } from '../ai/usage-observability.ts';
import { withAIAttribution } from '../ai/invocation-guard.ts';
import { withChatPhase } from '../ai/chat-usage.ts';

export interface JobUsageRun {
  totals: UsageTotals;
  startedAt: number;
  isolated: boolean;
  childReported: boolean;
  status: string;
  error_class: string | null;
}

/** Coarse submitter class from the job row alone (no DB read; never a display name). */
export function jobSubmittedBy(job: MinionJob): string {
  const authority = job.submission_authority;
  if (authority && authority.kind !== 'application') return 'mcp_client';
  if (job.parent_job_id != null) return 'parent_job';
  return authority ? 'local' : 'unreviewed';
}

function jobBase(job: MinionJob): Record<string, unknown> {
  const authority = job.submission_authority;
  return {
    evt: 'gbrain.job',
    id: job.id,
    name: job.name,
    queue: job.queue,
    submitted_by: jobSubmittedBy(job),
    submission_authority: authority
      ? { kind: authority.kind, principal: 'principal' in authority ? { kind: authority.principal.kind, id: authority.principal.id } : null }
      : null,
    attempts: job.attempts_made + 1,
  };
}

/** Open a job's usage run and emit its `phase: "start"` line. Never throws. */
export function startJobUsage(job: MinionJob, isolated: boolean): JobUsageRun {
  const run: JobUsageRun = { totals: newUsageTotals(), startedAt: Date.now(), isolated, childReported: false, status: 'released', error_class: null };
  try { emitUsageLine({ ...jobBase(job), phase: 'start', status: 'active' }); } catch { /* fail-open */ }
  return run;
}

/** Fold a child outcome file's `usage` into the run. Malformed input is ignored. */
export function mergeChildJobUsage(run: JobUsageRun, usage: unknown): void {
  const totals = usageTotalsFromJSON(usage);
  if (!totals) return;
  mergeUsageTotals(run.totals, totals);
  run.childReported = true;
}

/**
 * Record why the job ended: its status and an error CLASS, never the message.
 * An Error contributes its constructor name; a string is taken as a caller-chosen
 * class token (e.g. `no_handler`, `aborted`), capped at 64 chars.
 */
export function noteJobUsage(run: JobUsageRun, status: string, error?: unknown): void {
  run.status = status;
  if (error === undefined || error === null) return;
  try {
    if (typeof error === 'string') { run.error_class = error.slice(0, 64); return; }
    const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
    run.error_class = typeof name === 'string' && name ? name : typeof error;
  } catch { run.error_class = typeof error; }
}

/** Emit the job's `phase: "end"` line. Never throws. */
export function endJobUsage(job: MinionJob, run: JobUsageRun): void {
  try {
    const summary = summarizeUsage(run.totals);
    emitUsageLine({
      ...jobBase(job),
      phase: 'end',
      status: run.status,
      duration_ms: Date.now() - run.startedAt,
      calls: summary.calls,
      models: summary.models,
      cost_usd: summary.cost_usd,
      unpriced_calls: summary.unpriced_calls,
      ...(run.isolated ? { usage_complete: run.childReported } : {}),
      error_class: run.error_class,
    });
  } catch { /* fail-open */ }
}

/**
 * Run a job's handler in-process with the worker's attribution (worker.ts
 * executeJob parity), for drains that claim and run jobs themselves (the
 * cycle's inline drain, the facts drain): a usage scope, `job_id`/`job_name`
 * on every provider call, `phase = 'job:<name>'`, and `gbrain.job` start/end
 * lines. The end status is the handler's (`completed` or `error`), not the
 * queue's final routing. Rethrows the handler's error unchanged.
 */
export async function runJobWithUsage<T>(job: MinionJob, fn: () => Promise<T>): Promise<T> {
  const run = startJobUsage(job, false);
  try {
    const result = await withUsageScope(run.totals, () =>
      withAIAttribution({ job_id: job.id, job_name: job.name }, () => withChatPhase(`job:${job.name}`, fn)));
    noteJobUsage(run, 'completed');
    return result;
  } catch (err) {
    noteJobUsage(run, 'error', err);
    throw err;
  } finally {
    endJobUsage(job, run);
  }
}

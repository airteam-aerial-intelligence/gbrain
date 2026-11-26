/**
 * job-usage.ts — per-job provider usage and the `gbrain.job` start/end lines.
 *
 * The worker opens a usage scope per job (`withUsageScope`), so every provider
 * call the handler makes adds to the job's totals; a process-isolated child
 * reports its own totals back through the outcome file (`mergeChildJobUsage`).
 * A child that died before reporting leaves `usage_complete: false`.
 * Lines go through `emitUsageLine` (GBRAIN_USAGE_LOG); never payload text.
 */

import type { MinionJob } from './types.ts';
import { emitUsageLine, mergeUsageTotals, newUsageTotals, summarizeUsage, usageTotalsFromJSON, type UsageTotals } from '../ai/usage-observability.ts';

export interface JobUsageRun {
  totals: UsageTotals;
  startedAt: number;
  isolated: boolean;
  childReported: boolean;
  status: string;
  error: string | null;
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
  const run: JobUsageRun = { totals: newUsageTotals(), startedAt: Date.now(), isolated, childReported: false, status: 'released', error: null };
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

/** Record why the job ended (status + error text, capped at 300 chars). */
export function noteJobUsage(run: JobUsageRun, status: string, error?: unknown): void {
  run.status = status;
  if (error !== undefined && error !== null) {
    const text = error instanceof Error ? error.message : String(error);
    run.error = text.slice(0, 300);
  }
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
      error: run.error,
    });
  } catch { /* fail-open */ }
}

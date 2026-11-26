/**
 * op-usage.ts — attribute an MCP op's provider calls and report its usage.
 *
 * Every provider call a tool handler makes carries `op`, `caller` and
 * `transport` (chat_usage_log row + `gbrain.llm_call` line). When the op made
 * at least one call, one `gbrain.op` line sums them. Caller is the MCP client
 * name (or the OAuth client's name), plus `/<end user>` when the call named
 * one. Never arguments or results.
 */

import type { OperationContext } from '../core/ops/contract.ts';
import { withAIAttribution } from '../core/ai/invocation-guard.ts';
import { emitUsageLine, newUsageTotals, summarizeUsage, withUsageScope } from '../core/ai/usage-observability.ts';

export function opCaller(ctx: Pick<OperationContext, 'mcpCaller' | 'auth' | 'endUser'>): string | undefined {
  const client = ctx.mcpCaller?.client ?? ctx.auth?.clientName;
  if (!client && !ctx.endUser) return undefined;
  return ctx.endUser ? `${client ?? 'unknown'}/${ctx.endUser}` : client;
}

export async function withOpUsage<T>(ctx: Pick<OperationContext, 'mcpCaller' | 'auth' | 'endUser' | 'transport'>, op: string, fn: () => Promise<T>): Promise<T> {
  const totals = newUsageTotals();
  const caller = opCaller(ctx);
  const transport = ctx.transport ?? 'unknown';
  const startedAt = Date.now();
  let status = 'error';
  try {
    const out = await withUsageScope(totals, () => withAIAttribution({ op, ...(caller ? { caller } : {}), transport }, fn));
    status = 'ok';
    return out;
  } finally {
    try {
      const summary = summarizeUsage(totals);
      if (summary.calls >= 1) {
        emitUsageLine({ evt: 'gbrain.op', op, caller: caller ?? null, transport, duration_ms: Date.now() - startedAt, status,
          calls: summary.calls, models: summary.models, cost_usd: summary.cost_usd, unpriced_calls: summary.unpriced_calls });
      }
    } catch { /* fail-open */ }
  }
}

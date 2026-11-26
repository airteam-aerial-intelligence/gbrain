/**
 * usage-observability.ts — attribute every provider call.
 *
 * One process-wide observer of `invokeAI` (invocation-guard.ts) that, for each
 * provider call (chat, expansion, embedding, rerank, multimodal, decide,
 * transcription, subagent):
 *
 *   - adds the call to every enclosing usage scope (`withUsageScope`): a minion
 *     job, an MCP op, ... — nested scopes all see it;
 *   - writes one structured JSON line `{"evt":"gbrain.llm_call",...}` to stderr
 *     (default), stdout, or nowhere, per `GBRAIN_USAGE_LOG=stderr|stdout|off`;
 *   - hands a row to `recordProviderCall` (chat-usage.ts), the single writer
 *     of chat_usage_log.
 *
 * Lines carry an explicit whitelist of fields: model, tokens, cost, latency,
 * outcome, error class and attribution (job, op, caller, transport, CLI
 * command, request id). Never prompt or response text, never headers or keys,
 * never an error message. Every step is fail-open: observation never changes
 * or breaks the call.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { observeAIInvocations, type AIInvocation, type AIInvocationEvent, type AIInvocationUsage } from './invocation-guard.ts';
import { currentChatPhase, estimateChatCostUsd, recordProviderCall, type ChatUsageRecord } from './chat-usage.ts';
import { canonicalPricingKey, priceFor, type BudgetKind } from '../budget/reservation-cost.ts';

export type UsageLogMode = 'off' | 'stderr' | 'stdout';

/** `GBRAIN_USAGE_LOG`: `off`, `stdout`, or `stderr` (default; unknown values too). */
export function usageLogMode(env: NodeJS.ProcessEnv = process.env): UsageLogMode {
  const raw = env.GBRAIN_USAGE_LOG?.trim().toLowerCase();
  if (raw === 'off' || raw === 'stdout') return raw;
  return 'stderr';
}

/** Write one usage line (single write, so lines never interleave). Silent when the mode is `off`. Never throws. */
export function emitUsageLine(obj: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const mode = usageLogMode(env);
    if (mode === 'off') return;
    const line = JSON.stringify({ ts: new Date().toISOString(), severity: 'INFO', ...obj }) + '\n';
    if (mode === 'stdout') process.stdout.write(line);
    else process.stderr.write(line);
  } catch {
    /* fail-open */
  }
}

/** Provider of a model id: the prefix before ':'; a bare id is Anthropic's. */
export function providerOf(model: string): string {
  const i = model.indexOf(':');
  return i > 0 ? model.slice(0, i) : 'anthropic';
}

const NON_CHAT_KIND: Partial<Record<AIInvocation['kind'], BudgetKind>> = {
  embedding: 'embed',
  multimodal: 'embed',
  rerank: 'rerank',
  decide: 'decide',
};

/**
 * USD for one call. Chat prices from the canonical table with cache buckets at
 * their own rates (`usage.inputTokens` is uncached input); embedding, rerank,
 * multimodal and decide use the budget tracker's resolver. No usage, or no
 * price → null, never 0.
 */
export function priceCall(model: string, kind: AIInvocation['kind'], usage: AIInvocationUsage | null): number | null {
  if (!usage) return null;
  try {
    if (kind === 'chat') {
      const u = {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_tokens: usage.cacheReadTokens ?? 0,
        cache_write_tokens: usage.cacheWriteTokens ?? 0,
      };
      const direct = estimateChatCostUsd(model, u);
      if (direct !== null) return direct;
      const key = canonicalPricingKey(model);
      return key !== model ? estimateChatCostUsd(key, u) : null;
    }
    const budgetKind = NON_CHAT_KIND[kind];
    if (!budgetKind) return null;
    const price = priceFor(model, budgetKind);
    if (!price) return null;
    const input = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    return (input * price.pricing.input + usage.outputTokens * price.pricing.output) / 1_000_000;
  } catch {
    return null;
  }
}

// ---- Usage scopes ---------------------------------------------------------

export interface ModelUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  unpriced_calls: number;
}
/** Per-model totals for one scope (a job, an MCP op). `input_tokens` is uncached input. */
export type UsageTotals = Map<string, ModelUsage>;

export function newUsageTotals(): UsageTotals {
  return new Map();
}

interface ScopeFrame { totals: UsageTotals; parent: ScopeFrame | null }
const scopes = new AsyncLocalStorage<ScopeFrame>();

/** Run `fn` with every provider call inside it added to `totals` (and to every enclosing scope). */
export function withUsageScope<T>(totals: UsageTotals, fn: () => T): T {
  return scopes.run({ totals, parent: scopes.getStore() ?? null }, fn);
}

function emptyModelUsage(): ModelUsage {
  return { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0, unpriced_calls: 0 };
}

function addModelUsage(totals: UsageTotals, model: string, add: ModelUsage): void {
  const cur = totals.get(model) ?? emptyModelUsage();
  cur.calls += add.calls;
  cur.input_tokens += add.input_tokens;
  cur.output_tokens += add.output_tokens;
  cur.cache_read_tokens += add.cache_read_tokens;
  cur.cache_write_tokens += add.cache_write_tokens;
  cur.cost_usd += add.cost_usd;
  cur.unpriced_calls += add.unpriced_calls;
  totals.set(model, cur);
}

/** Merge `src` (a map or its JSON form) into `target`. */
export function mergeUsageTotals(target: UsageTotals, src: UsageTotals | Record<string, ModelUsage>): void {
  const entries = src instanceof Map ? [...src.entries()] : Object.entries(src);
  for (const [model, u] of entries) addModelUsage(target, model, u);
}

export function usageTotalsToJSON(totals: UsageTotals): Record<string, ModelUsage> {
  return Object.fromEntries([...totals.entries()].map(([m, u]) => [m, { ...u }]));
}

const MODEL_USAGE_FIELDS: Array<keyof ModelUsage> = ['calls', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd', 'unpriced_calls'];

/** Validate the JSON form (e.g. read from a child outcome file). Malformed → null. */
export function usageTotalsFromJSON(raw: unknown): UsageTotals | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = newUsageTotals();
  for (const [model, u] of Object.entries(raw as Record<string, unknown>)) {
    if (!u || typeof u !== 'object') return null;
    const rec = u as Record<string, unknown>;
    if (!MODEL_USAGE_FIELDS.every(f => typeof rec[f] === 'number' && Number.isFinite(rec[f] as number) && (rec[f] as number) >= 0)) return null;
    addModelUsage(out, model, rec as unknown as ModelUsage);
  }
  return out;
}

export interface UsageSummary {
  calls: number;
  models: Record<string, ModelUsage>;
  /** Sum over priced calls; null when calls were made and none could be priced. */
  cost_usd: number | null;
  unpriced_calls: number;
}

export function summarizeUsage(totals: UsageTotals): UsageSummary {
  let calls = 0, cost = 0, unpriced = 0;
  for (const u of totals.values()) { calls += u.calls; cost += u.cost_usd; unpriced += u.unpriced_calls; }
  return {
    calls,
    models: usageTotalsToJSON(totals),
    cost_usd: calls > 0 && unpriced === calls ? null : cost,
    unpriced_calls: unpriced,
  };
}

function addToScopes(event: AIInvocationEvent, cost: number | null): void {
  let frame = scopes.getStore() ?? null;
  if (!frame) return;
  const u = event.usage;
  const add: ModelUsage = {
    calls: 1,
    input_tokens: u?.inputTokens ?? 0,
    output_tokens: u?.outputTokens ?? 0,
    cache_read_tokens: u?.cacheReadTokens ?? 0,
    cache_write_tokens: u?.cacheWriteTokens ?? 0,
    cost_usd: cost ?? 0,
    unpriced_calls: cost === null ? 1 : 0,
  };
  for (; frame; frame = frame.parent) addModelUsage(frame.totals, event.call.model, add);
}

// ---- Lines and rows -------------------------------------------------------

function nonNegInt(n: number | undefined): number {
  return Number.isFinite(n) ? Math.max(0, Math.round(n as number)) : 0;
}

function jobIdOf(id: number | string | undefined): number | null {
  const n = typeof id === 'string' ? Number(id) : id;
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : null;
}

/** The `gbrain.llm_call` line for one call: an explicit field whitelist (never the call or its payload). */
export function llmCallLine(event: AIInvocationEvent, cost: number | null = priceCall(event.call.model, event.call.kind, event.usage)): Record<string, unknown> {
  const a = event.attribution ?? {};
  const u = event.usage;
  return {
    evt: 'gbrain.llm_call',
    ts: new Date(event.startedAt).toISOString(),
    severity: 'INFO',
    provider: providerOf(event.call.model),
    model: event.call.model,
    operation: event.call.operation,
    kind: event.call.kind,
    phase: a.phase ?? currentChatPhase(),
    outcome: event.outcome,
    error_class: event.errorClass ?? null,
    input_tokens: u ? nonNegInt(u.inputTokens) : null,
    output_tokens: u ? nonNegInt(u.outputTokens) : null,
    cache_read_tokens: u ? nonNegInt(u.cacheReadTokens) : null,
    cache_write_tokens: u ? nonNegInt(u.cacheWriteTokens) : null,
    cost_usd: cost,
    latency_ms: event.ms,
    job_id: a.job_id ?? null,
    job_name: a.job_name ?? null,
    op: a.op ?? null,
    caller: a.caller ?? null,
    transport: a.transport ?? null,
    cli_command: a.cli_command ?? null,
    request_id: a.request_id ?? null,
  };
}

/** The chat_usage_log row for one call. `input_tokens` keeps the table's meaning: total input incl. cache buckets. */
export function usageRowOf(event: AIInvocationEvent, cost: number | null): ChatUsageRecord {
  const a = event.attribution ?? {};
  const u = event.usage;
  const read = nonNegInt(u?.cacheReadTokens);
  const write = nonNegInt(u?.cacheWriteTokens);
  return {
    model: event.call.model,
    provider: providerOf(event.call.model),
    phase: currentChatPhase() ?? a.phase ?? null,
    input_tokens: u ? nonNegInt(u.inputTokens) + read + write : 0,
    output_tokens: nonNegInt(u?.outputTokens),
    cache_read_tokens: read,
    cache_write_tokens: write,
    cost_usd: cost,
    kind: event.call.kind,
    operation: event.call.operation,
    job_id: jobIdOf(a.job_id),
    job_name: a.job_name ?? null,
    op: a.op ?? null,
    caller: a.caller ?? null,
    cli_command: a.cli_command ?? null,
    latency_ms: nonNegInt(event.ms),
    outcome: event.outcome,
  };
}

function observeUsage(event: AIInvocationEvent): void {
  let cost: number | null = null;
  try { cost = priceCall(event.call.model, event.call.kind, event.usage); } catch { /* fail-open */ }
  // A refused call never reached the provider: it is logged, not counted or recorded.
  if (event.outcome !== 'refused') {
    try { addToScopes(event, cost); } catch { /* fail-open */ }
  }
  try { emitUsageLine(llmCallLine(event, cost)); } catch { /* fail-open */ }
  if (event.outcome !== 'refused') {
    try { recordProviderCall(usageRowOf(event, cost)); } catch { /* fail-open */ }
  }
}

let installed = false;

/** Register the process-wide usage observer. Idempotent. */
export function installUsageObservability(): void {
  if (installed) return;
  installed = true;
  observeAIInvocations(observeUsage);
}

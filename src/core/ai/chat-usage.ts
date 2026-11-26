/**
 * chat-usage.ts — durable per-call chat usage accounting (#4218, reviving the
 * #3392 shape).
 *
 * Every provider call made through `invokeAI` (chat, expansion, embedding,
 * rerank, multimodal, decide, transcription, subagent) is seen by the usage
 * observer (usage-observability.ts), which calls `recordProviderCall` — the
 * ONE writer of chat_usage_log rows. This module:
 *
 *   - attributes a best-effort PHASE via AsyncLocalStorage (`withChatPhase`):
 *     the minion worker wraps handler execution in `job:<name>`; `think`
 *     records as `think` when nothing outside set a phase
 *     (`withDefaultChatPhase`); query expansion always records as
 *     `expansion` (#7176); other direct CLI / op callers record with phase
 *     NULL unless they opt in. Attribution is advisory — a missing phase never
 *     blocks the record.
 *   - prices chat calls from CANONICAL_PRICING (`estimateChatCostUsd`),
 *     including cache_read/cache_write tokens at the provider's cache rates
 *     when the table carries them (Anthropic), falling back to the input
 *     rate otherwise. Unknown models record cost_usd = NULL (never a fake 0).
 *   - forwards the record to the registered sink FIRE-AND-FORGET. Accounting
 *     is strictly fail-open: a sink error (missing table pre-migration,
 *     closed engine, disk pressure) must never break a provider call.
 *
 * `recordChatUsage` (gateway.chat()/expand() success boundary) now only feeds
 * the in-process call meters; it no longer writes rows, so a chat call is
 * never counted twice.
 *
 * Coverage contract (surfaced by the `get_usage` op): every provider call in
 * a process whose sink is registered, with its outcome (failed calls record
 * 0 tokens and cost NULL). Calls made before the sink was registered or
 * before migration v140 are NOT covered. The attribution columns have no
 * numbered migration: the idempotent schema bootstrap
 * (src/core/engine-sql/bootstrap.ts) adds them on every initSchema; a brain
 * not yet re-initialized falls back to the original 8-column INSERT.
 * The budget tracker (budget-tracker.ts) remains the pessimistic in-flight
 * spend gate; this table is the after-the-fact ledger.
 *
 * No engine import here (the sink is injected) — this module stays a leaf so
 * the gateway can import it statically without deepening any cycle.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalLookup, priceAtPromptSize } from '../model-pricing.ts';
import { priceFor, type PricingOverrides } from '../budget/reservation-cost.ts';
import { embeddedEngineInScope } from '../engine-scope.ts';
import { engineKey } from '../engine-key.ts';
import { installUsageObservability } from './usage-observability.ts';

export interface ChatUsageRecord {
  /** "provider:modelId" of the model that actually answered. */
  model: string;
  /** Recipe/provider id when known (e.g. 'anthropic'). */
  provider: string | null;
  /** Best-effort attribution, e.g. 'job:embed-backfill'. NULL = direct/unattributed. */
  phase: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** USD, priced from CANONICAL_PRICING. NULL when the model has no pricing. */
  cost_usd: number | null;
  /** Attribution (bootstrap-added columns; see schema.sql). Absent/null = unknown. */
  kind?: string | null;
  operation?: string | null;
  job_id?: number | null;
  job_name?: string | null;
  op?: string | null;
  caller?: string | null;
  cli_command?: string | null;
  latency_ms?: number | null;
  outcome?: string | null;
  /** 'mcp' | 'http' | 'cli' | ... from the enclosing AI attribution. */
  transport?: string | null;
  /** Error class on a failed call (constructor name or `http_<status>`), never its message. */
  error_class?: string | null;
}

/** Columns the bootstrap adds; a brain missing any of them gets the legacy INSERT. */
const ATTRIBUTION_COLUMNS = [
  'kind', 'operation', 'job_id', 'job_name', 'op', 'caller', 'cli_command',
  'latency_ms', 'outcome', 'transport', 'error_class',
] as const;

export type ChatUsageSink = (record: ChatUsageRecord) => void | Promise<void>;

const __chatPhaseStore = new AsyncLocalStorage<string>();

/** Run `fn` with every gateway.chat() inside it attributed to `phase`. */
export function withChatPhase<T>(phase: string, fn: () => T): T {
  return __chatPhaseStore.run(phase, fn);
}

/** Like `withChatPhase`, but an enclosing phase (`job:<name>`, `phase:synthesize`) wins. */
export function withDefaultChatPhase<T>(phase: string, fn: () => T): T {
  return currentChatPhase() === null ? withChatPhase(phase, fn) : fn();
}

export function currentChatPhase(): string | null {
  return __chatPhaseStore.getStore() ?? null;
}

/**
 * Successful chat calls counted for one cycle phase (phase containment,
 * dream_paid_loop) or one nightly probe run. A meter that declares
 * `cost_usd` also prices each call with the budget tracker's resolver
 * (`priceFor`: `pricing_overrides`, then the shipped tables, the claude-cli
 * sibling rate and free local providers; table rows keep their cache-token
 * rates): priced calls add to `cost_usd`, unpriced ones add to
 * `unpriced_calls` instead of counting as 0.
 */
export interface ChatCallMeter {
  calls: number;
  cost_usd?: number;
  unpriced_calls?: number;
  pricing_overrides?: PricingOverrides;
}
const __chatMeterStore = new AsyncLocalStorage<ChatCallMeter>();

/** Run `fn` counting every successful gateway.chat() inside it on `meter`. */
export function withChatCallMeter<T>(meter: ChatCallMeter, fn: () => T): T {
  return __chatMeterStore.run(meter, fn);
}

/**
 * #4480: sink REGISTRY (stack), not a last-wins scalar. A multi-engine
 * process (migrate-engine source+target, doctor probes, tests) used to lose
 * its ledger permanently: the most recently created engine overwrote the
 * sink, and once that engine disconnected every later record was swallowed
 * by a closed engine. Registration now returns a deregister handle; the
 * engine factory calls it on engine.disconnect, restoring the previous live
 * sink. Records route to the TOP live entry (still single-writer —
 * simultaneous multi-brain attribution stays documented best-effort).
 */
interface SinkEntry { sink: ChatUsageSink; engine?: object }
let _sinks: SinkEntry[] = [];
/** An embedded engine's own sink, keyed by engineKey; never on the stack, and kept across reconnect() until it closes. */
const _engineSinks = new WeakMap<object, ChatUsageSink>();

/**
 * The sink a record goes to: in an embedded engine's scope, that engine's own (engine-scope.ts) or none once it
 * closed; otherwise the top of the stack, which never holds an embedded engine, so one brain's usage never lands in
 * another's database.
 */
function sinkInScope(): ChatUsageSink | null {
  const scoped = embeddedEngineInScope();
  if (scoped) return _engineSinks.get(engineKey(scoped)) ?? null;
  return _sinks.at(-1)?.sink ?? null;
}

/** Gives an engine opened from settings its own sink, off the process stack. Returns the handle its close calls. */
export function registerEngineChatUsageSink(engine: object, sink: ChatUsageSink): () => void {
  installUsageObservability();
  _engineSinks.set(engineKey(engine), sink);
  return () => { _engineSinks.delete(engineKey(engine)); };
}

/** Register a usage sink, for `engine` when given. Returns an idempotent deregister handle. */
export function registerChatUsageSink(sink: ChatUsageSink, engine?: object): () => void {
  installUsageObservability();
  const entry: SinkEntry = { sink, engine };
  _sinks.push(entry);
  return () => {
    _sinks = _sinks.filter((e) => e !== entry);
  };
}

/** @internal exported for tests: how many sinks the process stack holds. */
export function __chatUsageSinkCountForTests(): number {
  return _sinks.length;
}

/**
 * Legacy scalar API (tests + one-shot callers): clears the registry and
 * installs `sink` as the only entry (null = clear).
 */
export function setChatUsageSink(sink: ChatUsageSink | null): void {
  if (sink) installUsageObservability();
  _sinks = sink ? [{ sink }] : [];
}

/**
 * Price a chat call in USD from the canonical table. Cache tokens use the
 * table's cache_read/cache_write rates when present, else the input rate
 * (documented best-effort — see module doc). Unknown model → null.
 */
export function estimateChatCostUsd(
  model: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  },
): number | null {
  const row = canonicalLookup(model);
  if (!row) return null;
  const cacheRead = usage.cache_read_tokens ?? 0;
  const cacheWrite = usage.cache_write_tokens ?? 0;
  // #6448 item 1: the prompt size that selects a long-prompt tier is the
  // whole prompt — uncached input plus both cache buckets.
  const p = priceAtPromptSize(row, usage.input_tokens + cacheRead + cacheWrite);
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      cacheRead * (p.cache_read ?? p.input) +
      cacheWrite * (p.cache_write ?? p.input)) /
    1_000_000
  );
}

/**
 * The one writer of chat_usage_log rows: called by the usage observer for
 * every provider call. Resolves the sink in the caller's scope synchronously,
 * then writes fire-and-forget. Never throws.
 */
export function recordProviderCall(record: ChatUsageRecord): void {
  try {
    const sink = sinkInScope();
    if (!sink) return;
    void Promise.resolve(sink(record)).catch(() => {
      /* fail-open: accounting must never break a provider call */
    });
  } catch {
    /* fail-open */
  }
}

/**
 * Called by gateway.chat() / expand() at their success boundary. Feeds the
 * enclosing call meter only (rows come from `recordProviderCall`). Never
 * throws. `usage` is the gateway's `ChatResult.usage` (AI SDK convention):
 * `input_tokens` is the TOTAL input, and the cache read/write counts are
 * subsets of it, so the call is priced as (input - cache) at the input rate
 * plus each cache bucket at its own rate, never the cache tokens a second
 * time on top of the total.
 */
export function recordChatUsage(input: {
  model: string;
  provider?: string | null;
  /** An operation's own phase (`expansion`), over the ambient one. */
  phase?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
}): void {
  const meter = __chatMeterStore.getStore();
  if (!meter) return;
  meter.calls++;
  if (meter.cost_usd === undefined) return;
  try {
    const { input_tokens, output_tokens, cache_read_tokens = 0, cache_write_tokens = 0 } = input.usage;
    const uncached = Math.max(0, input_tokens - cache_read_tokens - cache_write_tokens);
    const cost_usd = estimateChatCostUsd(input.model, { ...input.usage, input_tokens: uncached });
    const price = priceFor(input.model, 'chat', meter.pricing_overrides);
    const meterCost = price === null ? null
      : price.source === 'table' && cost_usd !== null ? cost_usd
      : (input_tokens * price.pricing.input + output_tokens * price.pricing.output) / 1_000_000;
    if (meterCost === null) meter.unpriced_calls = (meter.unpriced_calls ?? 0) + 1;
    else meter.cost_usd = (meter.cost_usd ?? 0) + meterCost;
  } catch {
    /* fail-open */
  }
}

/**
 * Standard sink: INSERT into chat_usage_log via the engine's executeRaw.
 * Positional parameters only — no JSONB, no string-built SQL. Registered by
 * the engine factory (last engine created wins; multi-brain processes log
 * against the most recently created engine — documented best-effort).
 */
export function makeEngineChatUsageSink(engine: {
  executeRaw: (sql: string, params?: unknown[]) => Promise<unknown>;
}): ChatUsageSink {
  return async (r: ChatUsageRecord): Promise<void> => {
    const base = [
      r.model,
      r.provider,
      r.phase,
      r.input_tokens,
      r.output_tokens,
      r.cache_read_tokens,
      r.cache_write_tokens,
      r.cost_usd,
    ];
    try {
      await engine.executeRaw(
        `INSERT INTO chat_usage_log
           (model, provider, phase, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cost_usd,
            kind, operation, job_id, job_name, op, caller, cli_command,
            latency_ms, outcome, transport, error_class)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          ...base,
          r.kind ?? null,
          r.operation ?? null,
          r.job_id ?? null,
          r.job_name ?? null,
          r.op ?? null,
          r.caller ?? null,
          r.cli_command ?? null,
          r.latency_ms ?? null,
          r.outcome ?? null,
          r.transport ?? null,
          r.error_class ?? null,
        ],
      );
    } catch (err) {
      // A brain whose schema bootstrap has not added the attribution columns
      // yet (older binary initialized it, no initSchema since): fall back once
      // to the original 8-column INSERT. Lazy import keeps this module a leaf.
      const { isMissingSchemaObject } = await import('../utils.ts');
      if (!isMissingSchemaObject(err, 'column', ATTRIBUTION_COLUMNS)) throw err;
      await engine.executeRaw(
        `INSERT INTO chat_usage_log
           (model, provider, phase, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        base,
      );
    }
  };
}

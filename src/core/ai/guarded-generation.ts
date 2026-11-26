import { invokeAI, sdkInvocationUsage, hasAIInvocationGuard, hasAIInvocationObservers, type AIInvocation } from './invocation-guard.ts';
import { resolveChatContextTokens } from './model-resolver.ts';
import { assertModelAllowed } from './model-deny.ts';

export function chatInvocation(operation: string, model: string, maxOutputTokens: number): AIInvocation {
  let maxInputTokens: number | undefined;
  try { maxInputTokens = resolveChatContextTokens(model); } catch { /* finite admission refuses an unknown maximum */ }
  return { operation, kind: 'chat', model, maxInputTokens, maxOutputTokens };
}

/** Each SDK attempt has its own durable hold; local calls keep SDK retries. */
export function createGuardedGeneration(defaultMaxOutputTokens: () => number, operation = 'gateway.generate') {
  return async function guardedGeneration<T>(model: string, transport: (opts: any) => Promise<T>, opts: any): Promise<T> {
    if (!hasAIInvocationGuard()) {
      // Airteam fork: this branch skips invokeAI, so check the model ban here; the
      // others reach invokeAI, which refuses it as an observed `refused` call.
      if (!hasAIInvocationObservers()) {
        assertModelAllowed(model, operation);
        return transport(opts);
      }
      // Observed but unguarded: the transport sees the caller's options unchanged (SDK retries, token defaults).
      return invokeAI({ ...chatInvocation(operation, model, opts.maxOutputTokens ?? defaultMaxOutputTokens()) },
        () => transport(opts), sdkInvocationUsage);
    }
    const maxOutputTokens = opts.maxOutputTokens ?? defaultMaxOutputTokens();
    return invokeAI({ ...chatInvocation(operation, model, maxOutputTokens),
      cacheWriteTtl: opts.providerOptions?.anthropic?.cacheControl?.ttl ?? '5m' },
      () => transport({ ...opts, maxOutputTokens, maxRetries: 0 }), sdkInvocationUsage);
  };
}

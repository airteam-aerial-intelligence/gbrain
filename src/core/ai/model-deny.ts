/**
 * Airteam fork: models this brain never runs, for any caller, on any path.
 *
 * Hard-coded on purpose (not a config key): the ban must hold no matter what
 * `models.*`, `GBRAIN_MODEL`, an alias, a think/subagent `model` param, a
 * fallback chain or a sub-subagent names, and it must be checkable at
 * synchronous seams that have no engine (the gateway's generation wrapper,
 * `invokeAI`, the claude-cli language model). A config key could be cleared
 * by anyone who can write config; this cannot.
 *
 * Matched case-insensitively anywhere in the id, so `claude-fable-5`,
 * `anthropic:claude-fable-5-1`, `claude-cli:claude-fable-5-2` and any
 * provider-prefixed or dated variant are all refused.
 */
export const DENIED_MODEL_PATTERN = /fable/i;

export class DeniedModelError extends Error {
  readonly code = 'model_denied';
  constructor(readonly model: string, where?: string) {
    super(`model_denied: "${model}" is not allowed on this brain (Fable models are banned)${where ? ` [${where}]` : ''}. Use another model, for example claude-opus-4-7 or claude-sonnet-4-6.`);
    this.name = 'DeniedModelError';
  }
}

export function isDeniedModel(model: unknown): boolean {
  return typeof model === 'string' && DENIED_MODEL_PATTERN.test(model);
}

/** Throws DeniedModelError when `model` names a banned model; returns it unchanged otherwise. */
export function assertModelAllowed<T>(model: T, where?: string): T {
  if (isDeniedModel(model)) throw new DeniedModelError(model as unknown as string, where);
  return model;
}

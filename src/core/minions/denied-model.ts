/**
 * Airteam fork: a job whose model (explicit data.model or a resolved config default) is banned
 * (ai/model-deny.ts) dead-letters at handler entry, with no retries and no provider call.
 */
import { DeniedModelError, isDeniedModel } from '../ai/model-deny.ts';
import { UnrecoverableError } from './types.ts';

export async function allowedJobModelOrDead(model: string | Promise<string>, where: string): Promise<string> {
  let resolved: string;
  try { resolved = await model; } catch (e) {
    throw e instanceof DeniedModelError ? new UnrecoverableError(e.message) : e;
  }
  if (isDeniedModel(resolved)) throw new UnrecoverableError(new DeniedModelError(resolved, where).message);
  return resolved;
}

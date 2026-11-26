/**
 * Airteam fork: one brain tool call of a `remote_caller` job (remote-caller-authority.ts), bound to the submitting
 * credential exactly as an MCP call from it would be. The OperationContext gets the credential's auth (principal,
 * scopes, write source, read sources, operation allow-list, takes holders) and declared end user, so brain-allowlist's
 * `opCtx.auth` branch reads under remoteCallerAccess (live member binding, private pages, facts) and every handler's
 * own source and scope checks apply. The operation's declared scope and the credential's operation allow-list are
 * enforced here, before validation, the way HTTP dispatch enforces them before a handler runs.
 */
import type { Operation, OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { hasScope } from '../scope.ts';
import { remoteCallerToolAuth, type RemoteCallerAuthority } from './remote-caller-authority.ts';

export function confineRemoteCallerTool(a: RemoteCallerAuthority, op: Operation, opCtx: OperationContext): RemoteCallerAuthority {
  const auth = remoteCallerToolAuth(a);
  if (!hasScope(auth.scopes, op.scope as Parameters<typeof hasScope>[1])) {
    throw opError('permission_denied', `${op.name} needs the ${op.scope} scope, which the credential that submitted this job lacks; nothing ran.`,
      'Use a tool the submitting connection may call.');
  }
  if (auth.allowedOperations && !auth.allowedOperations.includes(op.name)) {
    throw opError('permission_denied', `${op.name} is not in the operation allow-list of the credential that submitted this job; nothing ran.`,
      'Use a tool the submitting connection may call.');
  }
  opCtx.auth = { token: '', ...auth } as OperationContext['auth'];
  opCtx.sourceId = a.grant.sourceId;
  opCtx.remote = true;
  const holders = narrowHolders(opCtx.takesHoldersAllowList, auth.takesHoldersAllowList);
  if (holders) opCtx.takesHoldersAllowList = holders;
  if (a.grant.endUser) opCtx.endUser = a.grant.endUser;
  return a;
}

/**
 * Take holders a confined tool call may read: the submitting credential's list, never wider than a list the
 * context already carries (intersection; `[]` stays deny-all). With neither list nothing is set, so readHolders
 * applies the same fail-closed `['world']` default MCP dispatch applies to that credential.
 */
export function narrowHolders(current: readonly string[] | undefined, credential: readonly string[] | undefined): string[] | undefined {
  if (!credential) return current ? [...current] : undefined;
  return current ? credential.filter(h => current.includes(h)) : [...credential];
}

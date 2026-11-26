/**
 * Airteam fork: `remote_caller` submission authority — a protected job (today: `subagent` only) a remote caller
 * submitted through submit_job (jobs.remote_protected_allow), confined to that caller's own access.
 *
 * The authority records the submitting credential (principal), its grant (scopes, write source, read sources,
 * operation allow-list, takes holders, tool surface), the end user it declared and the owner key job reads match.
 * Execution re-checks the credential live (assertCurrentRemoteJobPrincipal: not revoked, still admin on the same
 * source, still allowed submit_job) before every run, and every brain tool call the job's agent makes runs under an
 * OperationContext built from this grant (brain-allowlist.ts), so it sees and writes exactly what the same credential
 * and end user could over MCP: same sources, same private-page/fact/take visibility (remoteCallerAccess, resolved live
 * from the credential's member binding), same scope and operation checks, writes attributed to the end user.
 *
 * Job types that run brain-wide maintenance with direct database or filesystem access (synthesize, patterns,
 * consolidate, ...) cannot be confined to a grant, so they are never accepted under this authority. A job running
 * under it may enqueue descendants only of a confined type; they inherit the parent's authority unchanged (the grant
 * can never widen) and share its spend group.
 */
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { hasScope } from '../scope.ts';
import { isValidSourceId } from '../source-id.ts';
import { BRAIN_TOOL_ALLOWLIST } from './tools/brain-tool-allowlist.ts';
import { assertCurrentRemoteJobPrincipal, authorityDigest, jobOwnerKey, type RemoteJobAuthority } from './submission-authority.ts';

/** Protected job types whose work is confinable to a caller's grant (their brain access goes through operation contexts). */
export const CONFINED_REMOTE_JOB_NAMES: ReadonlySet<string> = new Set(['subagent']);

export interface RemoteCallerAuthority {
  version: 1;
  kind: 'remote_caller';
  principal: { kind: 'oauth_client' | 'legacy_token'; id: string };
  grant: {
    jobName: string;
    scopes: string[];
    sourceId: string;
    allowedSources: string[] | null;
    allowedOperations: string[] | null;
    takesHolders: string[] | null;
    surface: 'verbs' | 'starter' | 'full';
    owner: string;
    endUser?: string;
  };
  payloadHash: string;
}

/** Trusted subagent fields only host-side producers may set; a remote caller's data never carries them. */
const TRUSTED_SUBAGENT_FIELDS = ['brain_id', 'stage_writes', 'dream_output', 'corpus_source', 'oneshot_slug_suffix',
  'oneshot_task_prefixes', 'mode', 'is_self_fix_child', 'read_budget_bytes'];

function deny(message: string, suggestion: string): never {
  throw opError('permission_denied', `Queued job authorization: ${message}`, suggestion);
}
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string' && s.length > 0);

export function parseRemoteCallerAuthority(a: Record<string, unknown>): RemoteCallerAuthority | null {
  const p = a.principal as Record<string, unknown> | undefined, g = a.grant as Record<string, unknown> | undefined;
  if (!p || !g || !['oauth_client', 'legacy_token'].includes(String(p.kind)) || typeof p.id !== 'string' || !p.id) return null;
  if (typeof g.jobName !== 'string' || !CONFINED_REMOTE_JOB_NAMES.has(g.jobName) || !strings(g.scopes)
    || typeof g.sourceId !== 'string' || !isValidSourceId(g.sourceId)
    || !(g.allowedSources === null || (strings(g.allowedSources) && g.allowedSources.every(isValidSourceId)))
    || !(g.allowedOperations === null || strings(g.allowedOperations)) || !(g.takesHolders === null || strings(g.takesHolders))
    || !['verbs', 'starter', 'full'].includes(String(g.surface)) || typeof g.owner !== 'string' || !g.owner
    || (g.endUser !== undefined && (typeof g.endUser !== 'string' || !g.endUser))
    || typeof a.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(a.payloadHash)) return null;
  return structuredClone(a) as unknown as RemoteCallerAuthority;
}

/** The job data a confined job may run with: trusted fields and `__` stamps dropped, source and tools bound to the grant. */
export function confineRemoteCallerData(input: Record<string, unknown>, grant: RemoteCallerAuthority['grant']): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (!k.startsWith('__') && !TRUSTED_SUBAGENT_FIELDS.includes(k)) data[k] = v;
  data.source_id = grant.sourceId;
  const requested = strings(input.allowed_tools) ? input.allowed_tools.map(t => t.replace(/^brain_/, '')) : [...BRAIN_TOOL_ALLOWLIST];
  const tools = requested.filter(t => BRAIN_TOOL_ALLOWLIST.has(t) && (grant.allowedOperations === null || grant.allowedOperations.includes(t)));
  if (!tools.length) deny('no requested tool is both an agent tool and allowed for this credential',
    `Pass allowed_tools from: ${[...BRAIN_TOOL_ALLOWLIST].join(', ')} (and allowed for your connection), or omit it.`);
  data.allowed_tools = [...new Set(tools)];
  return data;
}

/** Accepts a confined protected job from a remote caller: the authority to store and the confined data. */
export async function prepareRemoteCallerJob(ctx: OperationContext, name: string, input: unknown): Promise<{ data: Record<string, unknown>; authority: RemoteCallerAuthority }> {
  if (!CONFINED_REMOTE_JOB_NAMES.has(name)) deny(`${name} runs brain-wide maintenance that cannot be confined to your access`,
    `Remote callers may queue only ${[...CONFINED_REMOTE_JOB_NAMES].join(', ')} jobs, which run with your own visibility. Submit a subagent job that does the work through its tools, or ask the brain host operator to run ${name} from the CLI.`);
  const auth = ctx.auth;
  const principal = auth?.principal;
  const sourceId = auth?.sourceId;
  if (!auth || !principal || (principal.kind !== 'oauth_client' && principal.kind !== 'legacy_token') || !sourceId || !isValidSourceId(sourceId)
    || ctx.sourceId !== sourceId || !hasScope(auth.scopes ?? [], 'admin')) deny('an authenticated persistent credential with one write source and the admin scope is required',
    'Connect with a persistent credential bound to one write source and holding the admin scope.');
  const { currentCallerAccess } = await import('../search/private-visibility.ts');
  const access = currentCallerAccess();
  if (access.actor || access.audience?.length) deny('jobs for an attested actor or an on-behalf-of audience are not supported here',
    'Submit without an actor or audience, or use submit_agent.');
  const input0 = input === undefined ? {} : input;
  if (typeof input0 !== 'object' || input0 === null || Array.isArray(input0)) deny('job data must be an object', 'Send data as a JSON object.');
  const owner = jobOwnerKey(auth, ctx.endUser)!;
  const grant: RemoteCallerAuthority['grant'] = {
    jobName: name, scopes: [...auth.scopes], sourceId,
    allowedSources: auth.allowedSources?.length ? [...auth.allowedSources] : null,
    allowedOperations: auth.allowedOperations == null ? null : [...auth.allowedOperations],
    takesHolders: auth.takesHoldersAllowList ? [...auth.takesHoldersAllowList] : null,
    surface: ctx.surface === 'verbs' || ctx.surface === 'starter' ? ctx.surface : 'full',
    owner, ...(ctx.endUser ? { endUser: ctx.endUser } : {}),
  };
  const data = confineRemoteCallerData(input0 as Record<string, unknown>, grant);
  const authority: RemoteCallerAuthority = { version: 1, kind: 'remote_caller', principal: { kind: principal.kind, id: principal.id }, grant, payloadHash: authorityDigest(data) };
  await assertCurrentRemoteCaller(ctx.engine, authority);
  return { data, authority };
}

/** Live check of the submitting credential (revocation, admin scope on the same source, submit_job allowed). */
export async function assertCurrentRemoteCaller(engine: OperationContext['engine'], a: RemoteCallerAuthority): Promise<void> {
  await assertCurrentRemoteJobPrincipal(engine, { principal: a.principal, grant: { scopes: a.grant.scopes, sourceId: a.grant.sourceId, allowedOperations: a.grant.allowedOperations } } as unknown as RemoteJobAuthority);
}

/** Runs in both workers before the handler: the row still matches what was accepted and the credential still holds. */
export async function authorizeRemoteCallerExecution(engine: OperationContext['engine'], a: RemoteCallerAuthority, job: { name: string; data: unknown }): Promise<void> {
  if (job.name !== a.grant.jobName || !CONFINED_REMOTE_JOB_NAMES.has(job.name) || authorityDigest(job.data) !== a.payloadHash) deny('job data or name differs from its accepted grant',
    `This ${job.name} job's data changed after it was accepted, so it does not run. Submit a new job.`);
  await assertCurrentRemoteCaller(engine, a);
}

/**
 * A descendant enqueued while a remote_caller job runs: a confined type only, the parent's grant unchanged, its data
 * confined the same way, and the parent's spend group. An explicit other authority is refused (never widened).
 */
export function inheritRemoteCaller(parent: RemoteCallerAuthority, name: string, data: Record<string, unknown> | undefined, explicit: unknown): { authority: RemoteCallerAuthority; data: Record<string, unknown> } {
  if (explicit !== undefined) throw new Error('A confined remote job cannot submit work under another authority');
  if (!CONFINED_REMOTE_JOB_NAMES.has(name.trim())) throw new Error(`A confined remote job cannot submit ${name} descendants`);
  const grant = { ...parent.grant, jobName: name.trim() };
  const confined = confineRemoteCallerData(data ?? {}, grant);
  return { authority: { ...parent, grant, payloadHash: authorityDigest(confined) }, data: confined };
}

/** The tool-call auth a confined job's agent runs under (brain-allowlist.ts buildOpContext). */
export function remoteCallerToolAuth(a: RemoteCallerAuthority) {
  return {
    clientId: a.principal.id, principal: { ...a.principal }, scopes: [...a.grant.scopes], sourceId: a.grant.sourceId,
    ...(a.grant.allowedSources ? { allowedSources: [...a.grant.allowedSources] } : {}),
    allowedOperations: a.grant.allowedOperations ? [...a.grant.allowedOperations] : null,
    ...(a.grant.takesHolders ? { takesHoldersAllowList: [...a.grant.takesHolders] } : {}),
  };
}

/**
 * queue.add's hook while a remote_caller job runs: the descendant takes the parent's authority (inheritRemoteCaller)
 * and the parent's spend authorization, so parent and children draw on one capped group. A descendant must name its
 * parent (opts.parent_job_id); without one, or under a parent with no spend record, it is refused.
 */
export async function inheritRemoteCallerSubmit<T extends { submissionAuthority?: unknown; allowProtectedSubmit?: boolean; spendAuthorization?: unknown }>(
  engine: OperationContext['engine'], parent: RemoteCallerAuthority, name: string, data: Record<string, unknown> | undefined,
  opts: { parent_job_id?: number | null } | undefined, trusted: T | undefined,
): Promise<{ data: Record<string, unknown>; trusted: T }> {
  const inherited = inheritRemoteCaller(parent, name, data, trusted?.submissionAuthority);
  const parentId = opts?.parent_job_id;
  if (typeof parentId !== 'number') throw new Error('A confined remote job\'s descendant must name its parent job');
  const [row] = await engine.executeRaw<{ spend_authorization: unknown }>('SELECT spend_authorization FROM minion_jobs WHERE id = $1', [parentId]);
  const spend = typeof row?.spend_authorization === 'string' ? JSON.parse(row.spend_authorization) : row?.spend_authorization;
  if (!spend || typeof spend !== 'object') throw new Error('A confined remote job\'s descendant needs its parent\'s spend authorization');
  return { data: inherited.data, trusted: { ...(trusted ?? {}), submissionAuthority: inherited.authority, allowProtectedSubmit: true, spendAuthorization: spend } as T };
}

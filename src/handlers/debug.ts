/**
 * SAPDiagnose action="debug" — one-shot ABAP debugger capture.
 *
 * ARC-1 is stateless HTTP, and a stopped debuggee holds a work process plus the request that ran it,
 * so the whole debugger loop completes inside ONE tool call (the same reasoning as "ADT locks never
 * cross an MCP round-trip"): arm breakpoints → long-poll the listener on the stateless client → run
 * the trigger → attach / read / step / release on one stateful session, opened on the debuggee's
 * application server (SAP attaches from no other) → always remove ARC-1's
 * breakpoints and the listener. The model gets a snapshot, never a remote control.
 * See docs/research/2026-10-22-abap-debugger-one-shot-capture.md.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import type { AdtClient } from '../adt/client.js';
import {
  createDebugIdentity,
  type DebugBreakpointSpec,
  type DebugBreakpointState,
  type Debuggee,
  DebuggerSession,
  type DebugIdentity,
  type DebugListenResult,
  type DebugReleaseResult,
  type DebugStackFrame,
  type DebugVariable,
  debuggerErrorSubType,
  debuggerErrorText,
  deleteBreakpoint,
  endSession,
  findListenerConflict,
  listenForDebuggee,
  openSessionOnServer,
  openSessionsAhead,
  type PinnedSession,
  type SessionsAhead,
  stopListener,
  syncBreakpoints,
} from '../adt/debugger.js';
import { runUnitTests } from '../adt/devtools.js';
import { assertODataPerfUrl } from '../adt/diagnostics.js';
import { AdtApiError } from '../adt/errors.js';
import { mapSapReleaseToAbaplintVersion } from '../adt/features.js';
import type { AdtHttpClient } from '../adt/http.js';
import { checkDebug, checkOperation, OperationType } from '../adt/safety.js';
import { getSessionUser, isPlausibleSapUser } from '../adt/session-user.js';
import { extractMethod } from '../context/method-surgery.js';
import { getCachedFeatures } from './feature-cache.js';
import { detectLocalHandlerInclude, objectUrlForType } from './object-types.js';
import { errorResult, type ToolResult, textResult, toolJson } from './shared.js';

const DEFAULT_TIMEOUT_SECONDS = 60;
/** `line`: SAP refuses lines without a statement, so probe the next few lines too. */
const LINE_PROBE = 5;
/** `method`: probe from the METHOD statement to the first line SAP accepts. */
const METHOD_PROBE = 16;
const MAX_FRAME_VARIABLES = 60;
const MAX_EXPANDED_STRUCTURES = 20;
const MAX_EXPANDED_TABLES = 5;
const MAX_COMPONENTS = 30;
const MAX_TABLE_ROWS = 5;
const MAX_VALUE_CHARS = 500;
const MAX_STACK_FRAMES = 15;
/** Attach + reads + steps once the debuggee is caught. */
const INSPECTION_BUDGET_MS = 120_000;
/** Own budget for the release, so an exhausted inspection can never leave a debuggee suspended. */
const RELEASE_BUDGET_MS = 60_000;
/** Opening the sessions ahead of the run (a few cheap requests). */
const AHEAD_BUDGET_MS = 20_000;
const CLASS_INCLUDES = new Set(['implementations', 'testclasses']);

const timings = {
  /** Head start for the long poll: SAP must register the listener before the trigger reaches the line. */
  armDelayMs: 1500,
  /** How long the capture still waits for the trigger's own answer after the release. */
  triggerSettleMs: 30_000,
};

/** Shrink the capture's fixed delays in unit tests; the capture semantics do not depend on them. */
export function setDebugTimingsForTests(overrides: Partial<typeof timings>): void {
  Object.assign(timings, overrides);
}

/** Captures in flight in this process, by SAP user: one at a time per user, `maxParallelCaptures` in all. */
const activeCaptures = new Set<string>();

class DebugInputError extends Error {}

type DebugTrigger = 'unittest' | 'http' | 'none';

interface DebugRequest {
  type: string;
  name: string;
  line?: number;
  method?: string;
  include?: string;
  exceptionClass?: string;
  trigger: DebugTrigger;
  triggerName?: string;
  url?: string;
  variables: string[];
  steps: number;
  timeoutSeconds: number;
}

function readRequest(args: Record<string, unknown>, type: string, name: string): DebugRequest {
  const str = (key: string): string | undefined =>
    typeof args[key] === 'string' && (args[key] as string).trim() ? (args[key] as string).trim() : undefined;
  const variables = Array.isArray(args.variables)
    ? (args.variables as unknown[]).map((v) => String(v).trim().toUpperCase()).filter(Boolean)
    : [];
  return {
    type,
    name: name.trim().toUpperCase(),
    ...(typeof args.line === 'number' ? { line: args.line } : {}),
    ...(str('method') ? { method: str('method') } : {}),
    ...(str('include') ? { include: str('include')?.toLowerCase() } : {}),
    ...(str('exceptionClass') ? { exceptionClass: str('exceptionClass')?.toUpperCase() } : {}),
    trigger: (str('trigger') as DebugTrigger | undefined) ?? 'unittest',
    ...(str('triggerName') ? { triggerName: str('triggerName')?.toUpperCase() } : {}),
    ...(str('url') ? { url: str('url') } : {}),
    variables: [...new Set(variables)],
    steps: typeof args.steps === 'number' ? args.steps : 0,
    timeoutSeconds: typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS,
  };
}

/**
 * The SAP user to debug: the session's own logon user, never a caller-supplied one. SAP names it
 * first, inside this very session (systeminformation): under principal propagation that is the
 * MCP user's own propagated SAP user. Where the release lacks that resource (SAP_BASIS 7.50 and
 * older) only identities that ARE the logon user count: SAP_USER behind Basic auth or operator
 * cookies, or the internal user a cloud create taught ARC-1, never a JWT display name. An empty or
 * wrong `requestUser` makes SAP's listener match nothing (or someone else), so unknown means refuse.
 */
export async function resolveDebugUser(client: AdtClient): Promise<string | undefined> {
  const fromSap = await getSessionUser(client.http, client.safety);
  if (fromSap) return fromSap;
  const known = ((client.usernameIsLogonUser ? client.username : '') || client.getInternalUser() || '')
    .trim()
    .toUpperCase();
  return isPlausibleSapUser(known) ? known : undefined;
}

/** A capture holds up to two SAP request slots (listener or inspection, plus the trigger), so at most
 *  a quarter of ARC1_MAX_CONCURRENT captures run at once: debugging never takes more than half of
 *  the slots every MCP user of the instance shares. */
export function maxParallelCaptures(slots: number): number {
  return Math.max(1, Math.floor(slots / 4));
}

// ─── Breakpoint location ───────────────────────────────────────────

interface LineTarget {
  /** Source URI the breakpoint fragment `#start=<line>` is appended to. */
  uri: string;
  /** Lines to probe in order. */
  candidates: number[];
  label: string;
}

function lineRange(from: number, to: number): number[] {
  const lines: number[] = [];
  for (let line = Math.max(1, from); line <= Math.max(from, to); line++) lines.push(line);
  return lines;
}

async function resolveFunctionGroup(client: AdtClient, name: string): Promise<string> {
  const group = await client.resolveFunctionGroup(name);
  if (!group) {
    throw new DebugInputError(
      `Cannot resolve the function group of ${name}. Check the name with SAPSearch("${name}").`,
    );
  }
  return group;
}

async function resolveLineTarget(client: AdtClient, req: DebugRequest): Promise<LineTarget | undefined> {
  if (req.line === undefined && req.method === undefined) return undefined;
  const encoded = encodeURIComponent(req.name.toLowerCase());
  if (req.type === 'CLAS') {
    const include = req.include ?? (req.method ? detectLocalHandlerInclude(req.method) : undefined);
    if (include && !CLASS_INCLUDES.has(include)) {
      throw new DebugInputError(`include must be "implementations" or "testclasses" (got "${include}").`);
    }
    const base = `/sap/bc/adt/oo/classes/${encoded}`;
    const uri = include ? `${base}/includes/${include}` : `${base}/source/main`;
    const where = include ? `include "${include}"` : 'the main source';
    if (req.method !== undefined) {
      // Breakpoints apply to the ACTIVE code — resolve the method against it, never a draft.
      const source = include
        ? (await client.getClassInclude(req.name, include, { version: 'active' })).source
        : (await client.getClass(req.name, undefined, { version: 'active' })).source;
      const release = getCachedFeatures()?.abapRelease;
      const found = extractMethod(
        source,
        req.name,
        req.method,
        release ? mapSapReleaseToAbaplintVersion(release) : undefined,
      );
      if (!found.success) {
        throw new DebugInputError(
          `${found.error ?? `Method "${req.method}" not found.`} Searched ${where} of ${req.name}; pass include= for local classes.`,
        );
      }
      return {
        uri,
        candidates: lineRange(found.startLine, Math.min(found.endLine, found.startLine + METHOD_PROBE - 1)),
        label: `CLAS ${req.name} method ${req.method}`,
      };
    }
    const line = req.line as number;
    return {
      uri,
      candidates: lineRange(line, line + LINE_PROBE - 1),
      label: `CLAS ${req.name} ${where} line ${line}`,
    };
  }
  if (req.method !== undefined) throw new DebugInputError('method is only supported for type="CLAS"; use line.');
  const line = req.line as number;
  if (req.type === 'PROG') {
    return {
      uri: `/sap/bc/adt/programs/programs/${encoded}/source/main`,
      candidates: lineRange(line, line + LINE_PROBE - 1),
      label: `PROG ${req.name} line ${line}`,
    };
  }
  if (req.type === 'FUNC') {
    const group = await resolveFunctionGroup(client, req.name);
    return {
      uri: `/sap/bc/adt/functions/groups/${encodeURIComponent(group.toLowerCase())}/fmodules/${encoded}/source/main`,
      candidates: lineRange(line, line + LINE_PROBE - 1),
      label: `FUNC ${req.name} line ${line}`,
    };
  }
  throw new DebugInputError(`Line breakpoints support type CLAS, PROG or FUNC (got "${req.type || '(none)'}").`);
}

// ─── Trigger ───────────────────────────────────────────────────────

type TriggerPlan =
  | { kind: 'unittest'; objectUrl: string; label: string }
  | { kind: 'http'; url: string; label: string }
  | { kind: 'none'; label: string };

type TriggerOutcome = { status: 'completed'; result: Record<string, unknown> } | { status: 'failed'; error: string };

/** The ABAP Unit object type of `name` — exact repository match on CLAS, PROG or FUGR. */
async function resolveUnitTestObjectType(client: AdtClient, name: string): Promise<string> {
  const matches = (await client.searchObject(name, 20))
    .filter((result) => result.objectName.toUpperCase() === name)
    .map((result) => result.objectType.split('/')[0] ?? '')
    .filter((type) => ['CLAS', 'PROG', 'FUGR'].includes(type));
  const types = [...new Set(matches)];
  if (types.length === 1) return types[0] as string;
  throw new DebugInputError(
    types.length === 0
      ? `triggerName ${name} is not a class, program or function group this system knows.`
      : `triggerName ${name} is ambiguous (${types.join(', ')}).`,
  );
}

async function planTrigger(client: AdtClient, req: DebugRequest): Promise<TriggerPlan> {
  if (req.trigger === 'none') return { kind: 'none', label: 'none (run it yourself as the same SAP user)' };
  if (req.trigger === 'http') {
    if (!req.url) throw new DebugInputError('trigger="http" needs url (a host-relative OData path).');
    try {
      assertODataPerfUrl(req.url);
    } catch {
      throw new DebugInputError(
        'trigger="http" url must be a host-relative OData path on the connected system — "/sap/opu/odata4/…" or "/sap/opu/odata/sap/<SRV>/…"; absolute URLs and other paths are rejected.',
      );
    }
    checkOperation(client.safety, OperationType.Query, 'DebugTriggerHttp');
    return { kind: 'http', url: req.url, label: `GET ${req.url}` };
  }
  let name = req.triggerName ?? req.name;
  let type = req.triggerName ? await resolveUnitTestObjectType(client, req.triggerName) : req.type;
  if (!type || !name) {
    throw new DebugInputError(
      'trigger="unittest" needs the unit-test object: triggerName (a CLAS, PROG or FUGR), or a CLAS/PROG/FUNC breakpoint object.',
    );
  }
  if (type === 'FUNC') {
    name = await resolveFunctionGroup(client, name);
    type = 'FUGR';
  }
  if (!['CLAS', 'PROG', 'FUGR'].includes(type)) {
    throw new DebugInputError(`trigger="unittest" runs ABAP Unit for CLAS, PROG or FUGR (got "${type}").`);
  }
  return { kind: 'unittest', objectUrl: objectUrlForType(type, name), label: `ABAP Unit ${type} ${name}` };
}

interface RunningTrigger {
  settled: Promise<TriggerOutcome>;
}

/** `session`: pinned ahead of the run — the unit tests, and so the debuggee, run on its server. */
function startTrigger(
  client: AdtClient,
  plan: TriggerPlan,
  fetchTimeoutMs: number,
  session?: AdtHttpClient,
): RunningTrigger | undefined {
  const options = { fetchTimeoutMs };
  let run: Promise<Record<string, unknown>>;
  if (plan.kind === 'unittest') {
    run = runUnitTests(session ?? client.http, client.safety, plan.objectUrl, { requestOptions: options }).then(
      (result) => ({
        outcome: result.outcome,
        ...result.summary,
      }),
    );
  } else if (plan.kind === 'http') {
    run = client.http
      .get(plan.url, undefined, options)
      .then((resp) => ({ statusCode: resp.statusCode, responseBytes: Buffer.byteLength(resp.body ?? '') }));
  } else {
    return undefined;
  }
  return {
    settled: run.then(
      (result): TriggerOutcome => ({ status: 'completed', result }),
      (err): TriggerOutcome => ({ status: 'failed', error: err instanceof Error ? err.message : String(err) }),
    ),
  };
}

// ─── Breakpoints ───────────────────────────────────────────────────

interface ArmedBreakpoints {
  /** Server ids of every breakpoint ARC-1 left armed — the cleanup list. */
  ids: string[];
  report: Array<Record<string, unknown>>;
}

const lineClientId = (line: number): string => `arc1-line-${line}`;
const EXCEPTION_CLIENT_ID = 'arc1-exception';

const isLineState = (state: DebugBreakpointState): boolean =>
  state.clientId !== EXCEPTION_CLIENT_ID && state.kind !== 'exception';

/** First candidate SAP armed, with the line SAP reports (it may move a breakpoint to the next statement). */
function acceptedLine(
  target: LineTarget,
  states: DebugBreakpointState[],
): { requested: number; line: number } | undefined {
  for (const requested of target.candidates) {
    const state = states.find(
      (candidate) =>
        candidate.id &&
        isLineState(candidate) &&
        (candidate.clientId === lineClientId(requested) || candidate.line === requested),
    );
    if (state) return { requested, line: state.line ?? requested };
  }
  return undefined;
}

/**
 * Arm the line breakpoint on the first candidate SAP accepts (one probe POST carrying every
 * candidate, then a second sync keeping only the accepted line) plus the optional exception one.
 */
async function armBreakpoints(
  client: AdtClient,
  identity: DebugIdentity,
  target: LineTarget | undefined,
  exceptionClass: string | undefined,
  armedIds: string[],
): Promise<ArmedBreakpoints> {
  const exceptionSpec: DebugBreakpointSpec[] = exceptionClass
    ? [{ kind: 'exception', clientId: EXCEPTION_CLIENT_ID, exceptionClass }]
    : [];
  const lineSpec = (line: number): DebugBreakpointSpec => ({
    kind: 'line',
    clientId: lineClientId(line),
    uri: target?.uri ?? '',
    line,
  });
  const remember = (states: DebugBreakpointState[]): DebugBreakpointState[] => {
    armedIds.splice(0, armedIds.length, ...states.flatMap((state) => (state.id ? [state.id] : [])));
    return states;
  };

  let states = remember(
    await syncBreakpoints(client.http, client.safety, identity, [
      ...(target ? target.candidates.map(lineSpec) : []),
      ...exceptionSpec,
    ]),
  );
  const report: Array<Record<string, unknown>> = [];
  if (target) {
    const accepted = acceptedLine(target, states);
    if (accepted === undefined) {
      const refusal = states.find((state) => state.error)?.error ?? 'SAP did not accept a breakpoint there';
      report.push({
        kind: 'line',
        location: target.label,
        status: 'refused',
        error: refusal,
        triedLines: target.candidates,
      });
    } else {
      // The probe may have armed several candidate lines — keep exactly the first accepted one.
      if (states.filter((state) => state.id && isLineState(state)).length > 1) {
        states = remember(
          await syncBreakpoints(client.http, client.safety, identity, [lineSpec(accepted.requested), ...exceptionSpec]),
        );
      }
      report.push({
        kind: 'line',
        location: target.label,
        status: 'set',
        line: accepted.line,
        uri: `${target.uri}#start=${accepted.line}`,
      });
    }
  }
  if (exceptionClass) {
    const state = states.find(
      (candidate) => candidate.clientId === EXCEPTION_CLIENT_ID || candidate.kind === 'exception',
    );
    report.push(
      state?.id
        ? { kind: 'exception', exceptionClass, status: 'set' }
        : { kind: 'exception', exceptionClass, status: 'refused', error: state?.error ?? 'not accepted by SAP' },
    );
  }
  return { ids: [...armedIds], report };
}

async function disarm(client: AdtClient, identity: DebugIdentity, ids: readonly string[], warnings: string[]) {
  let failed = false;
  for (const id of ids) {
    try {
      await deleteBreakpoint(client.http, client.safety, identity, id);
    } catch {
      failed = true;
    }
  }
  if (!failed) return;
  try {
    await syncBreakpoints(client.http, client.safety, identity, []);
  } catch (err) {
    warnings.push(
      `Could not remove ARC-1's external breakpoints: ${debuggerErrorText(err)} (they expire with the SAP user's debugging session).`,
    );
  }
}

// ─── Inspection ────────────────────────────────────────────────────

interface CapturedVariable {
  name: string;
  scope?: string;
  type?: string;
  kind: string;
  value?: string;
  truncated?: true;
  lines?: number;
  rows?: unknown[];
  components?: Record<string, string>;
  error?: string;
}

function clip(value: string): { value: string; truncated?: true } {
  const trimmed = value.trimEnd();
  return trimmed.length > MAX_VALUE_CHARS
    ? { value: trimmed.slice(0, MAX_VALUE_CHARS), truncated: true }
    : { value: trimmed };
}

/** One-line rendering for structure components, table rows and step values. */
function compactValue(variable: DebugVariable): string {
  if (variable.metaType === 'table') return `table[${variable.tableLines ?? 0}]`;
  if (variable.metaType === 'structure') return 'structure';
  return clip(variable.value).value;
}

function describeVariable(variable: DebugVariable, scope?: string): CapturedVariable {
  const type = variable.declaredType || variable.actualType || variable.technicalType;
  const base: CapturedVariable = {
    name: variable.name || variable.id,
    ...(scope ? { scope } : {}),
    ...(type ? { type } : {}),
    kind: variable.metaType || 'unknown',
  };
  if (variable.metaType === 'table') return { ...base, lines: variable.tableLines ?? 0 };
  if (variable.metaType === 'structure') return base;
  const clipped = clip(variable.value);
  return { ...base, value: clipped.value, ...(clipped.truncated || variable.incomplete ? { truncated: true } : {}) };
}

/** Group child-variable rows by the parent each was requested for. */
function childrenByParent(
  response: Awaited<ReturnType<DebuggerSession['childVariables']>>,
): Map<string, DebugVariable[]> {
  const byId = new Map(response.variables.map((variable) => [variable.id, variable]));
  const grouped = new Map<string, DebugVariable[]>();
  for (const row of response.hierarchies) {
    const child = byId.get(row.childId);
    if (!child) continue;
    const list = grouped.get(row.parentId) ?? [];
    list.push(child);
    grouped.set(row.parentId, list);
  }
  return grouped;
}

function componentsOf(children: DebugVariable[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const child of (children ?? []).slice(0, MAX_COMPONENTS)) out[child.name || child.id] = compactValue(child);
  return out;
}

/** Expand structures one level and the first rows of tables — two batched requests, never per variable. */
async function expand(session: DebuggerSession, pairs: Array<{ variable: DebugVariable; out: CapturedVariable }>) {
  const structures = pairs.filter((pair) => pair.variable.metaType === 'structure').slice(0, MAX_EXPANDED_STRUCTURES);
  const tables = pairs
    .filter((pair) => pair.variable.metaType === 'table' && (pair.variable.tableLines ?? 0) > 0)
    .slice(0, MAX_EXPANDED_TABLES);
  if (structures.length > 0) {
    const grouped = childrenByParent(await session.childVariables(structures.map((pair) => pair.variable.id)));
    for (const pair of structures) pair.out.components = componentsOf(grouped.get(pair.variable.id));
  }
  if (tables.length === 0) return;
  const rowIds = tables.flatMap((pair) => {
    const base = pair.variable.id.replace(/\[\]$/, '');
    const count = Math.min(pair.variable.tableLines ?? 0, MAX_TABLE_ROWS);
    return Array.from({ length: count }, (_, index) => `${base}[${index + 1}]`);
  });
  const rows = await session.variables(rowIds);
  const rowById = new Map(rows.map((row) => [row.id.toUpperCase(), row]));
  const structuredRows = rows.filter((row) => row.metaType === 'structure');
  const rowComponents =
    structuredRows.length > 0
      ? childrenByParent(await session.childVariables(structuredRows.map((row) => row.id)))
      : undefined;
  for (const pair of tables) {
    const base = pair.variable.id.replace(/\[\]$/, '');
    const count = Math.min(pair.variable.tableLines ?? 0, MAX_TABLE_ROWS);
    pair.out.rows = Array.from({ length: count }, (_, index) => {
      const row = rowById.get(`${base}[${index + 1}]`.toUpperCase());
      if (!row) return null;
      return row.metaType === 'structure' ? componentsOf(rowComponents?.get(row.id)) : compactValue(row);
    });
  }
}

async function readNamedVariables(session: DebuggerSession, names: readonly string[]): Promise<CapturedVariable[]> {
  let found: DebugVariable[] = [];
  const failures = new Map<string, string>();
  try {
    found = await session.variables(names);
  } catch {
    // One unknown expression can fail the whole batch — retry one by one to say which.
    for (const name of names) {
      try {
        found.push(...(await session.variables([name])));
      } catch (err) {
        failures.set(name, debuggerErrorText(err));
      }
    }
  }
  const pairs: Array<{ variable: DebugVariable; out: CapturedVariable }> = [];
  // SAP echoes the expression as ID; a 1:1 answer can also be matched by position.
  const byPosition = found.length === names.length && failures.size === 0;
  const result = names.map((name, index): CapturedVariable => {
    const variable =
      found.find((candidate) => candidate.id.toUpperCase() === name || candidate.name.toUpperCase() === name) ??
      (byPosition ? found[index] : undefined);
    if (!variable) return { name, kind: 'unknown', error: failures.get(name) ?? 'not visible in the stopped frame' };
    const out = { ...describeVariable(variable), name };
    pairs.push({ variable, out });
    return out;
  });
  await expand(session, pairs);
  return result;
}

/**
 * The stopped frame's variables. Releases differ in what `@ROOT` holds (research dossier §3.4): real
 * variable rows directly, or scope nodes (pseudo ids like `@…`, or children without a variable row
 * of their own) whose children are the variables. Both are read; scopes in one batched request.
 */
async function readFrameVariables(session: DebuggerSession, warnings: string[]): Promise<CapturedVariable[]> {
  const root = await session.childVariables(['@ROOT']);
  const rootVariableIds = new Set(root.variables.map((variable) => variable.id));
  const scopes = root.hierarchies.filter(
    (row) =>
      row.parentId === '@ROOT' && row.childId && (row.childId.startsWith('@') || !rootVariableIds.has(row.childId)),
  );
  const scopeName = new Map(scopes.map((row) => [row.childId, row.childName || row.childId]));
  const rows: Array<{ variable: DebugVariable; scope?: string }> = root.variables
    .filter((variable) => !variable.id.startsWith('@') && !scopeName.has(variable.id))
    .map((variable) => ({ variable }));
  if (scopes.length > 0) {
    const grouped = childrenByParent(await session.childVariables(scopes.map((row) => row.childId)));
    for (const [parentId, children] of grouped) {
      for (const variable of children) rows.push({ variable, scope: scopeName.get(parentId) });
    }
  }
  if (rows.length > MAX_FRAME_VARIABLES) {
    warnings.push(
      `The frame has ${rows.length} variables; the first ${MAX_FRAME_VARIABLES} are shown. Name the ones you need in "variables" to read them in full.`,
    );
  }
  const pairs = rows.slice(0, MAX_FRAME_VARIABLES).map(({ variable, scope }) => ({
    variable,
    out: describeVariable(variable, scope),
  }));
  // Locals: one level of structure components; table rows only when a table is named explicitly.
  await expand(
    session,
    pairs.filter((pair) => pair.variable.metaType === 'structure'),
  );
  return pairs.map((pair) => pair.out);
}

function describeFrame(frame: DebugStackFrame): Record<string, unknown> {
  const procedure = [frame.eventType, frame.eventName].filter(Boolean).join(' ');
  return {
    ...(procedure ? { procedure } : {}),
    program: frame.program,
    ...(frame.include && frame.include !== frame.program ? { include: frame.include } : {}),
    ...(frame.line !== undefined ? { line: frame.line } : {}),
    ...(frame.uri ? { uri: frame.uri } : {}),
  };
}

interface Inspection {
  attached: boolean;
  stack?: DebugStackFrame[];
  variables?: CapturedVariable[];
  steps?: Array<Record<string, unknown>>;
  release?: DebugReleaseResult;
  error?: string;
}

/** `watch`: the requested names that were readable at the stop — an unknown one would fail every step. */
async function runSteps(
  session: DebuggerSession,
  req: DebugRequest,
  watch: readonly string[],
  warnings: string[],
): Promise<Array<Record<string, unknown>>> {
  const steps: Array<Record<string, unknown>> = [];
  for (let index = 1; index <= req.steps; index++) {
    const outcome = await session.step('stepOver');
    if (outcome.status === 'ended') {
      steps.push({ step: index, ended: true });
      break;
    }
    const [top] = await session.stack();
    const entry: Record<string, unknown> = { step: index, ...(top ? describeFrame(top) : {}) };
    if (watch.length > 0) {
      const values: Record<string, string> = {};
      try {
        for (const variable of await session.variables(watch))
          values[variable.id || variable.name] = compactValue(variable);
        entry.values = values;
      } catch (err) {
        entry.valuesError = debuggerErrorText(err);
      }
    }
    steps.push(entry);
    if (!outcome.steppingPossible) {
      warnings.push(`SAP reports stepping is no longer possible after step ${index}.`);
      break;
    }
  }
  return steps;
}

/**
 * A refusal SAP answered leaves nothing attached — a 4xx, or its "cannot attach" exception
 * (`invalidDebuggee`, sent as a 500); a transport failure leaves the state unknown.
 */
function attachDefinitelyFailed(err: unknown): boolean {
  if (!(err instanceof AdtApiError)) return false;
  return (err.statusCode >= 400 && err.statusCode < 500) || debuggerErrorSubType(err) === 'invalidDebuggee';
}

async function inspect(
  client: AdtClient,
  identity: DebugIdentity,
  debuggee: Debuggee,
  req: DebugRequest,
  breakpointIds: readonly string[],
  onAttached: () => Promise<void>,
  warnings: string[],
  ready: AdtHttpClient | undefined,
): Promise<Inspection> {
  if (debuggee.attachImpossible) {
    if (ready) await endSession(ready, client.safety, { deadline: Date.now() + RELEASE_BUDGET_MS });
    return {
      attached: false,
      error:
        'SAP reports this debuggee cannot be attached (IS_ATTACH_IMPOSSIBLE), e.g. it runs on another application server.',
    };
  }
  const deadline = Date.now() + INSPECTION_BUDGET_MS;
  let pinned: PinnedSession;
  try {
    pinned = ready
      ? { http: ready, instance: debuggee.instance, probes: 0 }
      : await openSessionOnServer(client.http, client.safety, debuggee.instance, { deadline });
  } catch (err) {
    return { attached: false, error: `Could not open a debugger session: ${debuggerErrorText(err)}` };
  }
  const sessionHttp = pinned.http;
  const session = new DebuggerSession(sessionHttp, client.safety, identity, { deadline });
  let attachState: 'none' | 'attached' | 'unknown' = 'unknown';
  const inspection: Inspection = { attached: false };
  try {
    const attach = await session.attach(debuggee.id);
    attachState = 'attached';
    inspection.attached = true;
    if (attach.postMortem) warnings.push('SAP attached a post-mortem (short dump) session — inspection only.');
    await onAttached();
    inspection.stack = await session.stack();
    inspection.variables =
      req.variables.length > 0
        ? await readNamedVariables(session, req.variables)
        : await readFrameVariables(session, warnings);
    if (req.steps > 0) {
      const watch = (inspection.variables ?? [])
        .filter((variable) => req.variables.includes(variable.name) && !variable.error)
        .map((variable) => variable.name);
      if (attach.steppingPossible) inspection.steps = await runSteps(session, req, watch, warnings);
      else warnings.push('SAP reports stepping is not possible for this debuggee; steps were skipped.');
    }
  } catch (err) {
    if (attachState === 'unknown' && attachDefinitelyFailed(err)) attachState = 'none';
    const subType = debuggerErrorSubType(err);
    inspection.error = `${debuggerErrorText(err)}${subType ? ` (${subType})` : ''}`;
    if (subType === 'noSessionAttached') {
      inspection.error +=
        ' — the attach did not survive into the next request. Releases below 7.51 need the stateful-session support ADT writes also need (see issue #293).';
    }
    const elsewhere =
      pinned.instance && debuggee.instance && pinned.instance.toUpperCase() !== debuggee.instance.toUpperCase();
    if (subType === 'invalidDebuggee' && elsewhere) {
      inspection.error += ` — SAP attaches only from the debuggee's application server (${debuggee.instance}), and none of ${pinned.probes} new sessions landed there (the last on ${pinned.instance}): while a debuggee waits, SAP's load balancer sends new sessions elsewhere. Retry the capture.`;
    }
  } finally {
    if (attachState !== 'none') {
      const releaser = new DebuggerSession(sessionHttp, client.safety, identity, {
        deadline: Date.now() + RELEASE_BUDGET_MS,
      });
      inspection.release = await releaser.release(breakpointIds);
    }
    // A debuggee that could not be released keeps its debugger session; any other ends here.
    if (attachState === 'none' || inspection.release?.released) {
      await endSession(sessionHttp, client.safety, { deadline: Date.now() + RELEASE_BUDGET_MS });
    }
  }
  return inspection;
}

// ─── Capture ───────────────────────────────────────────────────────

type ListenSettled = DebugListenResult | { status: 'error'; error: unknown };

function notHitHint(req: DebugRequest, user: string, triggerFinished: boolean): string {
  const race =
    ' If the line is certainly executed, retry once: the run may have reached it before SAP registered the listener.';
  if (triggerFinished && req.trigger === 'unittest') {
    return `The unit tests finished without reaching the breakpoint — check that a harmless test covers this code (SAPDiagnose action="unittest" coverage=true lists methodsBelowFull), or use trigger="http" / trigger="none".${race}`;
  }
  if (triggerFinished) return `The trigger finished without reaching the breakpoint.${race}`;
  return `Nothing stopped within ${req.timeoutSeconds}s. With trigger="none", run the code as SAP user ${user} (the same user) while the capture waits — e.g. open the Fiori app or run the report — and retry.`;
}

/**
 * Sessions opened before the run (see `openSessionsAhead`). Only ARC-1's unit-test trigger can run on
 * one; for the others the pair's second session is ended at once. A failure only costs the pinning.
 */
async function openAhead(client: AdtClient, plan: TriggerPlan, warnings: string[]): Promise<SessionsAhead> {
  let ahead: SessionsAhead;
  try {
    ahead = await openSessionsAhead(client.http, client.safety, { deadline: Date.now() + AHEAD_BUDGET_MS });
  } catch (err) {
    warnings.push(
      `Could not open debugger sessions ahead of the run (${debuggerErrorText(err)}); the attach looks for the debuggee's server after the stop instead.`,
    );
    return { byServer: new Map() };
  }
  if (ahead.trigger && plan.kind !== 'unittest') {
    await endSession(ahead.trigger, client.safety, { deadline: Date.now() + AHEAD_BUDGET_MS });
    return { byServer: ahead.byServer };
  }
  return ahead;
}

async function runCapture(client: AdtClient, req: DebugRequest, user: string): Promise<ToolResult> {
  const identity = createDebugIdentity(user);
  const warnings: string[] = [];
  // Everything that can fail on input is resolved BEFORE any debugger state exists on SAP.
  const target = await resolveLineTarget(client, req);
  if (!target && !req.exceptionClass) {
    throw new DebugInputError('Give a breakpoint: line or method (with type + name), and/or exceptionClass.');
  }
  const plan = await planTrigger(client, req);

  const conflict = await findListenerConflict(client.http, client.safety, identity);
  if (conflict) {
    return errorResult(
      `Another debugger is already listening for SAP user ${user}: ${conflict}. ARC-1 never takes over an active debug session (Eclipse, VS Code or another capture) — stop that session first.`,
    );
  }

  const armedIds: string[] = [];
  let ahead: SessionsAhead = { byServer: new Map() };
  let attachedFrom: AdtHttpClient | undefined;
  let listenerStarted = false;
  let externalCleared = false;
  let tornDown = false;
  let running: RunningTrigger | undefined;
  const listenAbort = new AbortController();
  const clearExternal = async () => {
    if (externalCleared) return;
    externalCleared = true;
    await disarm(client, identity, armedIds, warnings);
  };
  // Idempotent: runs before the result is built (so its warnings are reported) and again in finally.
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    listenAbort.abort();
    await clearExternal();
    for (const session of ahead.byServer.values()) {
      if (session !== attachedFrom)
        await endSession(session, client.safety, { deadline: Date.now() + RELEASE_BUDGET_MS });
    }
    if (!listenerStarted) return;
    try {
      await stopListener(client.http, client.safety, identity.user);
    } catch (err) {
      warnings.push(`Could not remove the debugger listener for ${identity.user}: ${debuggerErrorText(err)}.`);
    }
  };
  const settleTrigger = async (): Promise<Record<string, unknown> | undefined> => {
    if (!running) return undefined;
    const settled = await Promise.race([running.settled, sleep(timings.triggerSettleMs).then(() => undefined)]);
    // The trigger's session ends with its run; a run still going keeps it until SAP's session timeout.
    if (settled && ahead.trigger)
      await endSession(ahead.trigger, client.safety, { deadline: Date.now() + RELEASE_BUDGET_MS });
    return settled ?? { status: 'running', note: 'still running when the capture returned' };
  };

  try {
    const armed = await armBreakpoints(client, identity, target, req.exceptionClass, armedIds);
    if (armed.ids.length === 0) {
      return errorResult(
        toolJson({ hit: false, error: 'SAP refused every breakpoint — nothing was armed.', breakpoints: armed.report }),
      );
    }

    ahead = await openAhead(client, plan, warnings);
    listenerStarted = true;
    const listen: Promise<ListenSettled> = listenForDebuggee(client.http, client.safety, identity, req.timeoutSeconds, {
      signal: listenAbort.signal,
    }).catch((error: unknown) => ({ status: 'error' as const, error }));

    if (plan.kind !== 'none') {
      await sleep(timings.armDelayMs);
      running = startTrigger(
        client,
        plan,
        req.timeoutSeconds * 1000 + INSPECTION_BUDGET_MS + RELEASE_BUDGET_MS,
        ahead.trigger,
      );
    }
    const first = await Promise.race([
      listen.then((outcome) => ({ source: 'listener' as const, outcome })),
      ...(running ? [running.settled.then((outcome) => ({ source: 'trigger' as const, outcome }))] : []),
    ]);
    // A suspended run cannot finish: a trigger that settles first ran without stopping — end the poll.
    const triggerFinished = first.source === 'trigger';
    if (triggerFinished) listenAbort.abort();
    const outcome: ListenSettled = first.source === 'listener' ? first.outcome : await listen;
    const base = { user, breakpoints: armed.report, trigger: { kind: plan.kind, target: plan.label } };

    if (outcome.status !== 'caught') {
      await teardown();
      const triggerOutcome = await settleTrigger();
      const triggerFailure =
        first.source === 'trigger' && first.outcome.status === 'failed' ? first.outcome : undefined;
      const reason =
        outcome.status === 'conflict'
          ? `conflict: ${outcome.message}`
          : triggerFailure
            ? `trigger failed: ${triggerFailure.error}`
            : triggerFinished
              ? 'trigger finished without reaching the breakpoint'
              : outcome.status === 'error'
                ? `listener failed: ${debuggerErrorText(outcome.error)}`
                : 'timeout';
      return textResult(
        toolJson({
          hit: false,
          reason,
          ...base,
          trigger: { ...base.trigger, ...(triggerOutcome ?? {}) },
          ...(warnings.length > 0 ? { warnings } : {}),
          hint: notHitHint(req, user, triggerFinished),
        }),
      );
    }

    const { debuggee } = outcome;
    attachedFrom = debuggee.instance ? ahead.byServer.get(debuggee.instance.toUpperCase()) : undefined;
    const inspection = await inspect(client, identity, debuggee, req, armed.ids, clearExternal, warnings, attachedFrom);
    await teardown();
    const triggerOutcome = await settleTrigger();
    if (inspection.release && !inspection.release.released) {
      warnings.push(
        `The debuggee could not be released (${inspection.release.detail ?? 'unknown'}); it stays suspended until SAP's debugger timeout ends its session.`,
      );
    }
    const stack = inspection.stack ?? [];
    const visible = stack.filter((frame) => !frame.systemProgram);
    return textResult(
      toolJson({
        hit: true,
        ...base,
        debuggee: {
          user: debuggee.user,
          program: debuggee.program,
          include: debuggee.include,
          ...(debuggee.line !== undefined ? { line: debuggee.line } : {}),
          ...(debuggee.kind ? { kind: debuggee.kind } : {}),
          ...(debuggee.instance ? { server: debuggee.instance } : {}),
        },
        attached: inspection.attached,
        ...(stack[0] ? { stoppedAt: describeFrame(stack[0]) } : {}),
        ...(stack.length > 0 ? { stack: visible.slice(0, MAX_STACK_FRAMES).map(describeFrame) } : {}),
        ...(stack.length > visible.length ? { hiddenSystemFrames: stack.length - visible.length } : {}),
        ...(inspection.variables ? { variables: inspection.variables } : {}),
        ...(inspection.steps ? { steps: inspection.steps } : {}),
        ...(inspection.release ? { release: inspection.release } : {}),
        ...(inspection.error ? { error: inspection.error } : {}),
        trigger: { ...base.trigger, ...(triggerOutcome ?? {}) },
        ...(warnings.length > 0 ? { warnings } : {}),
      }),
    );
  } finally {
    await teardown();
  }
}

/** Entry point for SAPDiagnose action="debug". */
export async function handleDebugCapture(
  client: AdtClient,
  args: Record<string, unknown>,
  type: string,
  name: string,
): Promise<ToolResult> {
  checkDebug(client.safety, 'DebugCapture');
  const semaphore = client.http.semaphore;
  if (semaphore && semaphore.max < 2) {
    return errorResult(
      `A debug capture holds one SAP request open (the listener) while the trigger runs, so it needs ARC1_MAX_CONCURRENT >= 2 (currently ${semaphore.max}).`,
    );
  }
  const user = await resolveDebugUser(client);
  if (!user) {
    return errorResult(
      "Cannot tell which SAP user this session runs as, and SAP's debugger needs that logon user (requestUser) to catch anything. SAP did not name it (/sap/bc/adt/core/http/systeminformation is missing on SAP_BASIS 7.50 and older); there, only SAP_USER with Basic or cookie auth identifies it — under principal propagation ARC-1 refuses rather than guess from the token.",
    );
  }
  // From here to activeCaptures.add() nothing awaits, so the checks and the claim are atomic.
  if (activeCaptures.has(user)) {
    return errorResult(
      `A debug capture for SAP user ${user} is already running on this ARC-1 instance — wait for it to finish.`,
    );
  }
  const limit = semaphore ? maxParallelCaptures(semaphore.max) : Number.POSITIVE_INFINITY;
  if (activeCaptures.size >= limit) {
    return errorResult(
      `Debugging is at its limit on this ARC-1 instance (${activeCaptures.size} capture(s) running; at most ${limit}, a quarter of ARC1_MAX_CONCURRENT=${semaphore?.max}, so debugging never holds more than half of the SAP request slots everyone shares) — retry when one finishes.`,
    );
  }
  activeCaptures.add(user);
  try {
    return await runCapture(client, readRequest(args, type, name), user);
  } catch (err) {
    if (err instanceof DebugInputError) return errorResult(err.message);
    throw err;
  } finally {
    activeCaptures.delete(user);
  }
}

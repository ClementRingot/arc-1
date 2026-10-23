# ABAP debugger for ARC-1 — one-shot breakpoint capture dossier

> **Evidence level: corroborated; live-verified on the BTP ABAP Environment only (2026-10-23, §9).**
> No SAP system was reachable from the session that produced this dossier, so the contract facts
> below come from three independent client implementations that drive the same SAP resources, two of
> them with recorded live verification; facts marked **(L)** were since observed live by ARC-1. The
> feature ships **default-off** behind `SAP_ALLOW_DEBUG` until the remaining §9 checks have been run
> on 7.50, 758 and 816.

## 1. Goal

"Implement the debug function on ARC-1": let an LLM answer *"what are the values at line N when this
code runs?"* — the question a developer answers with the ABAP debugger — without an IDE.

## 2. The roadmap assumption that was wrong

`docs_page/roadmap.md` (FEAT-29b) and `docs/compare/01-vibing-steampunk.md` list the debugger as
*"Requires WebSocket + ZADT_VSP deployment"*. That is not a property of SAP's debugger, it was an
artifact of how vibing-steampunk (VSP) first drove it:

- `abap-adt-api` (marcellourbani, v9.2.0, `build/api/debugger.js`) has always driven the debugger over
  plain ADT REST. The VS Code extension `vscode_abap_remote_fs` (`client/src/adt/debugger/*`) ships a
  full DAP debugger on top of it — no Z code, no WebSocket.
- VSP itself now runs the identical loop "over one stateful HTTPS session … nothing installed on the
  server" (`README.md`, `docs/design/http-only-systems.md`, verified against A4H 7.58 on 2026-08-21).
  The comment in `internal/mcp/handlers_debugger_legacy.go` gives the real reason the HTTP tools once
  shipped disabled: *"listen and attach each got their own session, so the attach never found the
  debuggee the listen had caught. Nothing about the resources was wrong — only the session under
  them."*

What the debugger needs is **one stateful ADT session (`sap-contextid`) that lives from the attach to
the release, on the application server the debuggee waits on** (§3.6). ARC-1 already had the
primitive: `AdtHttpClient.withStatefulSession()`, now also `openStatefulSession()` for picking one.

## 3. Verified-by-reference ADT contract

Sources: **A** = abap-adt-api 9.2.0 `build/api/debugger.js` + `AdtClient.js`; **V** = vscode_abap_remote_fs
`debugListener.ts`, `debugService.ts`, `breakpointManager.ts`, `variableManager.ts`; **S** = VSP
`pkg/adt/debugger.go`, `pkg/saprfc/adtdebug.go`, `pkg/saprfc/adtbatch.go`, README (live notes).

### 3.1 Identity triple

Every listener/breakpoint request carries `debuggingMode=user`, `requestUser=<SAP user, upper case>`,
`terminalId`, `ideId` (A, S). In user mode SAP keys the **listener** by user alone — `ABDBG_LISTENER`
holds `IDE_ID=<user>`, `TERMINAL_ID='%_USER'` (S). **`requestUser` must be the real SAP logon user:** an
empty user registers a listener that "matches nothing — it waits out its whole timeout" (S). ARC-1
asks SAP for the session's user (`/sap/bc/adt/core/http/systeminformation`, absent on SAP_BASIS 7.50
and older) and refuses when neither SAP nor an authoritative configuration names it (§7.3).

### 3.2 Breakpoints — `POST /sap/bc/adt/debugger/breakpoints`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<dbg:breakpoints scope="external" debuggingMode="user" requestUser="DEVELOPER"
    terminalId="…" ideId="…" systemDebugging="false" deactivated="false"
    xmlns:dbg="http://www.sap.com/adt/debugger">
  <syncScope mode="full"></syncScope>
  <breakpoint xmlns:adtcore="http://www.sap.com/adt/core" kind="line" clientId="arc1-1" skipCount="0"
      adtcore:uri="/sap/bc/adt/oo/classes/zcl_x/source/main#start=42"/>
  <breakpoint kind="exception" clientId="arc1-2" skipCount="0" exceptionClass="CX_SY_ZERODIVIDE"/>
</dbg:breakpoints>
```

- `Content-Type: application/xml`, `Accept: application/xml` (A, S). Simple transformation
  `TPDA_ADT_BREAKPOINTS_REQUEST` (S).
- Response `<dbg:breakpoints><breakpoint kind id clientId adtcore:uri …/>…`; a refused one keeps its
  `clientId` and carries `errorMessage` instead of `id` — e.g. *"Cannot create a breakpoint at this
  position"* for a line without a statement (S, live). Ids look like
  `KIND=0.SOURCETYPE=ABAP.MAIN_PROGRAM=…` (S, live).
- Kinds accepted by SAP: `line`, `statement`, `exception`, `message` (S, live A4H). Message breakpoints
  need all of `msgId`/`msgNo`/`msgTy` (S).
- Line-breakpoint URI = the object's source URI + `#start=<line>`: `…/oo/classes/<c>/source/main`,
  `…/oo/classes/<c>/includes/implementations|testclasses`, `…/programs/programs/<p>/source/main`,
  `…/functions/groups/<g>/fmodules/<f>/source/main` (V uses the object's contents path). Program
  *includes* need a VIT URI with the main program (V) — out of scope for v1.
- The POST is a **sync of the IDE's breakpoint set**: `syncScope mode="full"` replaces the set, `partial`
  + `<adtcore:objectReference adtcore:uri=…/>` replaces it inside one object (A, V). `GET` answers 200
  with an empty body — the set is IDE state (S). ARC-1 uses a **fresh `ideId` per capture**, so a full
  sync only ever touches ARC-1's own set; cleanup posts the empty full set.
- `DELETE /sap/bc/adt/debugger/breakpoints/{id}?scope=&debuggingMode=&requestUser=&terminalId=&ideId=`
  removes one (A, S).
- Breakpoints in SAP standard code are accepted but never fire without `systemDebugging` (S). ARC-1
  never sets system debugging.

### 3.3 Listener — `/sap/bc/adt/debugger/listeners`

| Call | Contract |
|---|---|
| Conflict check | `GET …?debuggingMode=user&requestUser=&terminalId=&ideId=&checkConflict=true` → empty body = no conflict; an ADT exception whose `com.sap.adt.communicationFramework.subType` is `conflictDetected`/`conflictNotification` = another IDE (Eclipse, VS Code, …) is listening for the user (A, V). |
| Listen | `POST …?debuggingMode=user&requestUser=&terminalId=&ideId=&checkConflict=true&isNotifiedOnConflict=true&timeout=<s>`, `Accept: application/vnd.sap.as+xml` (S). **Long poll**: returns when a debuggee stops, on conflict, or at the server timeout. **Empty body = nobody stopped** (S). A caught debuggee arrives as `<asx:abap><asx:values><DATA><STPDA_DEBUGGEE>` with `DEBUGGEE_ID`, `DEBUGGEE_USER`, `PRG_CURR`, `INCL_CURR`, `LINE_CURR`, `DBGEE_KIND`, `IS_ATTACH_IMPOSSIBLE`, newer releases also `URI`, `TYPE`, `NAME` (A, S), and where the debuggee waits: `INSTANCE_NAME` (the server name `sap-contextid` carries), `IS_SAME_SERVER` (relative to the listener's server), `CAN_ADT_CROSS_SERVER` (A, L). |
| Stop | `DELETE …?debuggingMode=user&requestUser=<USER>` — **by user only**; a DELETE quoting the ids "matches no row" and the registration silently swallows the next debuggee (S, live). Removing it also ends external debugging for the user and drops the user's external breakpoints (S). |

The registration survives the poll's return — it must be deleted explicitly (S). A client that stops
waiting does not stop the server-side poll; it runs to its timeout, so it must not sit on the session
the debugger needs (S). ARC-1 therefore runs the long poll on the **stateless** client (as V does) and
removes the registration through it.

### 3.4 Debug session (one stateful session from attach to release)

| Operation | Request | Notes |
|---|---|---|
| Attach | `POST /sap/bc/adt/debugger?method=attach&debuggeeId=&dynproDebugging=true&debuggingMode=user&requestUser=` | Response `<dbg:attach isSteppingPossible isPostMortem …><reachedBreakpoints><breakpoint id kind/>`. The debuggee is attachable only while it waits — listen → attach must be back-to-back, otherwise `invalidDebuggee` (`CX_ABDBG_ACTEXT_CANNOT_ATTACH`) (S). **Only from the debuggee's own application server** (§3.6, L). |
| Stack | `GET /sap/bc/adt/debugger/stack?method=getStack&emode=_&semanticURIs=true`; **7.50 has no `/debugger/stack`** (404) → `POST /sap/bc/adt/debugger?method=getStack&emode=_&semanticURIs=true` (A gates on discovery, S retries on 404 — live 7.50). | `<dbg:stack><stackEntry stackPosition stackType stackUri programName includeName line eventType eventName sourceType systemProgram isVit uri/>`. |
| Variables | `POST /sap/bc/adt/debugger?method=getVariables`, body `<asx:abap><asx:values><DATA><STPDA_ADT_VARIABLE><ID>LV_X</ID></STPDA_ADT_VARIABLE>…`, `Content-Type: application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.debugger.Variables` | Rows `STPDA_ADT_VARIABLE` (`ID`, `NAME`, `DECLARED_TYPE_NAME`, `ACTUAL_TYPE_NAME`, `META_TYPE`, `VALUE`, `TECHNICAL_TYPE`, `LENGTH`, `TABLE_LINES`, `IS_VALUE_INCOMPLETE`, …). Table rows are addressed as `ITAB[1]` (V). |
| Child variables | `POST /sap/bc/adt/debugger?method=getChildVariables`, body `<DATA><HIERARCHIES><STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>@ROOT</PARENT_ID>…`, `dataname=com.sap.adt.debugger.ChildVariables` | `HIERARCHIES` (`PARENT_ID`, `CHILD_ID`, `CHILD_NAME`) + `VARIABLES`. `@ROOT`'s children are the frame's scopes (V lists them as the Variables-view scopes); several parents fit in one request. Structure components = children of the structure id (V). |
| Step | `POST /sap/bc/adt/debugger?method=stepInto|stepOver|stepReturn|stepContinue|stepRunToLine|stepJumpToLine|terminateDebuggee` | `<dbg:step …>`. `stepContinue` answering 200 = stopped again (still attached); exception `debuggeeEnded` / `noSessionAttached` = released (S). |
| Release | `method=detach` is **unknown on 7.58** (400 "Unknown method") → `stepContinue` until `debuggeeEnded` (S); V does the same (`stepContinue`, falling back to dropping the session). | `terminateDebuggee` kills the user's session — last resort only. |

Accept: S found that naming a concrete media type makes ADT answer **404 "No suitable resource found"**
on releases whose resource only produces its own vendor type (that is how 7.50's stack looked "absent");
ARC-1 sends `Accept: */*` on attach/stack/step, and the vendor `vnd.sap.as+xml` on the listener and the
variable calls (the shapes S verified).

Errors are ADT exception documents; the machine-readable part is
`<entry key="com.sap.adt.communicationFramework.subType">…</entry>` (A `parseDebugError`, V `errorType`):
`conflictDetected`, `conflictNotification`, `invalidDebuggee`, `noSessionAttached`, `debuggeeEnded`,
`notAuthorized`.

### 3.5 Per-release notes

| Release | Note | Source |
|---|---|---|
| 7.50 | No `/debugger/stack` resource → dispatcher `getStack`. | S (live) |
| < 7.51 | ADT does not honor `X-sap-adt-sessiontype: stateful` natively (`src/adt/release.ts`, issue #293) — the attach lives in a session the next request cannot reach unless the `abapfs_extensions` enhancement is installed. Expect `noSessionAttached` after attach. | ARC-1 #293 |
| 7.58 | `method=detach` unknown; breakpoint kinds line/statement/exception/message verified. | S (live A4H) |
| BTP ABAP | Same resources (Eclipse debugs BTP). Several application servers (pods `appserver-…`): the attach must come from the debuggee's (§3.6). `systeminformation` names the internal user (`CB99…`) under PP. | L |

### 3.6 Reaching the debuggee's application server (live, BTP ABAP, 2026-10-23)

On a system with several application servers the attach must come from **a session on the server the
debuggee waits on** (`INSTANCE_NAME`). Observed on the BTP ABAP Environment trial (two servers):

- From any other server SAP answers **500 `invalidDebuggee`** (`CX_ABDBG_ACTEXT_CANNOT_ATTACH`,
  raised in `CL_ABDBG_ACT_FOR_ATTACH__USER`), although the debuggee reports `IS_ATTACH_IMPOSSIBLE=false`
  and `CAN_ADT_CROSS_SERVER=true`. `dynproDebugging=true|false` makes no difference.
- **The refused attempt spoils the debuggee**: every later attach fails the same way, from the right
  server too (the exception moves from line 24 to line 9 of the same method). Retrying is useless; the
  first attach has to be from the right server.
- Running the listener on a stateful session and attaching on it does not help: the debuggee waits on
  whichever server ran the trigger, not on the listener's (`IS_SAME_SERVER=false`, `LISTENER_CTX_ID`
  empty).
- The first attach from a session on the debuggee's server succeeds, and stack, variables and steps
  follow on that session.

Nothing addresses a server directly. A new stateful session is load-balanced, and SAP names where it
landed in the `sap-contextid` cookie, `SID:ANON:<instance>:<context id>` (`appserver-t4w2x` there,
`<host>_<SID>_<nr>` on classic systems), which the load balancer then routes the session by.

**Find the server before the stop, not after.** The balancer prefers the least-loaded server, and a
stopped debuggee loads its own (it holds a work process). So once a debuggee waits, new sessions avoid
exactly the server it waits on: 16 of 16 probes landed on the other server, either way round, with
fresh TCP connections too (`Connection: close` changed nothing). Probing after the stop worked only
when other users' load happened to tip the balance.

So the capture opens its sessions **before the run** (`openSessionsAhead`, `src/adt/debugger.ts`):
stateful sessions with one cheap `GET /core/http/systeminformation` each, until two land on the same
server (at most 6; a balanced pair takes 3). ARC-1's unit-test trigger runs on the second session of
that pair, so the debuggee stops on its server, where the first session waits to attach. For a run
ARC-1 does not start (`trigger="none"`, or `http`), the attach takes whichever waiting session is on
the debuggee's server. Only when none is does it probe after the stop (`openSessionOnServer`, at
most 8) — and then usually fails, with a message saying why. Every session it opens is closed the way
Eclipse ADT closes one (`AdtHttpClient.endStatefulSession`: the dedicated close-session request on
that context): unused ones at once, the debugger's own after the release, the trigger's after its run. Without a
server name (no `INSTANCE_NAME`, another cookie shape, no systeminformation on 7.50), the attach goes
wherever it lands, as before.

## 4. Why a one-shot capture, not an interactive session

VSP keeps one debug session open across tool calls in a long-lived process. ARC-1 cannot and should
not:

1. **ARC-1 is stateless HTTP** (`sessionIdGenerator: undefined`, fresh Server per request, possibly
   several CF instances — ADR-0006 "MCP legacy era"): a later tool call can land on an instance that
   does not hold the `sap-contextid`. This is the same reasoning as the invariant *"ADT locks never
   cross an MCP round-trip"*.
2. **A stopped debuggee holds a work process** and the caller's request (the OData call, the unit-test
   run) hangs until released. An LLM thinking for minutes between `step` calls would hold both.
3. **The debuggee is only attachable while it waits** (§3.4) — an id copied between tool calls loses the
   race (S found the same and merged listen+attach).

So the whole loop — arm, run, catch, attach, read, step, release, clean up — completes **inside one
`SAPDiagnose` call**, bounded by `timeoutSeconds` and `steps`. The LLM gets a *snapshot* (stack +
variables at the stop, plus an optional bounded step trace) instead of a remote control. Everything the
model needs must be asked for up front (`variables`, `steps`), which also keeps the output small.

## 5. Design (as shipped)

`SAPDiagnose action="debug"` — listed only when the server allows it (§7).

| Parameter | Meaning |
|---|---|
| `type` + `name` | Object holding the breakpoint: `CLAS`, `PROG`, `FUNC`. |
| `line` / `method` | 1-based line in the object's main source (or in `include`), or a `CLAS` method (`get_total`, `lhc_travel~validate`, `zif_x~run`) → ARC-1 resolves the `METHOD` line with `extractMethod` and walks forward to the first line SAP accepts. |
| `include` | `CLAS` only: `implementations` / `testclasses` — the include `line` refers to (auto-detected for `lhc_`/`lcl_`/`ltc_` methods). |
| `exceptionClass` | Optional exception breakpoint (with or without a line breakpoint). |
| `trigger` | `unittest` (default): harmless ABAP Unit of `triggerName` (a CLAS/PROG/FUGR resolved by exact repository match; default: the breakpoint object, FUNC → its FUGR). `http`: GET of `url` — a host-relative OData path, same guard as `odata_perf`. `none`: wait while *you* run it (Fiori app, SE38, Postman) as the same SAP user. |
| `variables` | Variable expressions to read at the stop and after every step (`LV_TOTAL`, `LS_HEAD-VBELN`, `LT_ITEMS`, `ME->MV_STATE`, `SY-SUBRC`). Default: the stopped frame's variables (children of `@ROOT`'s scopes). |
| `steps` | 0–20 `stepOver`s after the stop, each recording position + `variables`. |
| `timeoutSeconds` | How long to wait for the hit (1–240, default 60). |

Flow: ask SAP who the session is (§7.3) → per-user in-process mutex + per-instance capture cap →
conflict check → set breakpoints (fresh `ideId`,
full sync) → start the long poll (stateless) → arm delay → start the trigger → race (hit / trigger
finished / timeout) → attach + stack + variables + steps on one stateful session on the debuggee's
application server, opened before the run (§3.6) → release
(clear session breakpoints, `stepContinue` until ended; `terminateDebuggee` only as last resort) →
always: clear external breakpoints, delete the listener, settle the trigger.

Output (JSON): `hit`, `debuggee` (incl. `server`), `breakpoints` (set / refused with SAP's message), `stoppedAt`,
`stack` (customer frames, system frames counted), `variables` (simple values, one level of structure
components, first table rows; values truncated), `steps` (each watched variable, structures by their
components), `release`, `trigger` (outcome; `server` when ARC-1 pinned its run), `warnings`.

## 6. ARC-1 impact

| Area | Files |
|---|---|
| ADT client | new `src/adt/debugger.ts` (builders, parsers, listener/session ops, release); new `src/adt/session-user.ts` (systeminformation "who am I"); `src/adt/client.ts` (`usernameIsLogonUser`) |
| Handler | new `src/handlers/debug.ts` (orchestration), `src/handlers/diagnose.ts` (`case 'debug'`) |
| Schema | `src/handlers/schemas.ts` (Zod + refinements), `src/handlers/tools.ts` + new `src/handlers/tools-debug.ts` (JSON schema, listed only when enabled) |
| Policy / safety | `src/authz/policy.ts` (`SAPDiagnose.debug` → `data` / Query), `src/adt/safety.ts` (`allowDebug`, `checkDebug`, scope/profile derivation), `src/server/{types,config,server,effective-policy-log,ui-state,multi-target-runtime,destination-registry}.ts`, `src/cli.ts` |
| Multi-target | `debug` is not in the SAPDiagnose multi-target allowlist; multi-target runtime forces `allowDebug=false` |
| Docs | `docs_page/{tools,configuration-reference,authorization,security-guide,roadmap}.md`, `docs/compare/00-feature-matrix.md`, `AGENTS.md`, `.env.example` |

## 7. Security model

### 7.1 Gates (all must pass)

1. **Server opt-in `SAP_ALLOW_DEBUG=true`** (default false) — a dedicated switch, never implied by
   another flag (I7).
2. **`SAP_ALLOW_DATA_PREVIEW=true`** — variable values are business data, exactly like table preview.
3. **`data` scope** (`ACTION_POLICY['SAPDiagnose.debug']`); `SAP_DENY_ACTIONS=SAPDiagnose.debug` blocks it.
4. **SAP authorization** of the logon user: `S_DEVELOP` with `OBJTYPE=DEBUG` for display debugging
   (standard SAP concept — verify against your roles). ARC-1 never needs "debug & replace".
5. Every debugger HTTP call is preceded by `checkDebug(safety, …)` — gated by construction (I1-style).

### 7.2 What ARC-1 deliberately never does

- No variable writes (`setVariableValue`), no `stepJumpToLine`, no `systemDebugging` — these change
  what the program does or reach SAP standard code.
- No `requestUser` from the model: the debug user is always the logon user. A shared technical user
  must not be able to catch somebody else's session.
- No breakpoint, listener or attached debuggee survives the call — `finally` cleanup on every path.

### 7.3 Who the debug user is

Always the session's own logon user, never a value from the model or from a token claim:

1. **SAP names it.** `GET /sap/bc/adt/core/http/systeminformation` with
   `Accept: application/vnd.sap.adt.core.http.systeminformation.v1+json` answers
   `{systemID, client, userName, userFullName, language}` for the session that asks
   (`src/adt/session-user.ts`). It runs inside the caller's own session, so under principal
   propagation each MCP user gets their **own propagated SAP user** (whatever the Cloud Connector /
   `CERTRULE` mapping produced), on the BTP ABAP Environment the internal `CB99…` user, under Basic the
   logon user. No `SAP_USER` is needed for any of them. One GET per capture, never cached (cookie
   hot-reload can change who the session is). Evidence: SAP Fiori tools — `@sap-ux/axios-extension`
   2.1.2, `SystemInfoService.getSystemInfo()` and `AbapServiceProvider.user()` (= the configured user,
   else this `userName`), type `SystemInfo` in `dist/abap/types/adt-types.d.ts`; vibing-steampunk
   `pkg/adt/identity.go` ("Eclipse ADT reads it right after logon"), absent on SAP_BASIS 7.50 and older
   (vibing-steampunk issue #382).
2. **Release without the resource** (404/405/406/501): only identities that *are* the logon user
   count — `SAP_USER` behind Basic auth (SAP accepted its password) or set by the operator beside cookie
   auth, or the internal user a cloud create taught ARC-1 (`getInternalUser`). Whenever a per-user token
   authenticates (PP, SAML, bearer) `AdtClient.usernameIsLogonUser` is false: there `username` is a JWT
   display claim (`user_name`/`email`) that need not match the SAP user the Cloud Connector maps to, so
   using it could arm breakpoints for a *different* SAP user.
3. Otherwise the capture is **refused with an explicit message**. Any other failure of the GET
   (401/403/5xx, network) propagates rather than falling back silently.

When SAP's answer and `SAP_USER` differ, SAP's answer wins: it is the user the debugger sees.

Correction to earlier research: issue #636 and the BTP package-create plan concluded "no whoami
endpoint" after probing `/sap/bc/adt/core/systeminformation` (no `/http/`), `security/users/current`,
`system/users/me` and `/$self`; the `/http/` resource was not among them. Moving package create's
`responsible` resolution onto it is a separate follow-up, after the §9 check.

### 7.4 Residual risks

- **Shared technical user** (one `SAP_USER` for many MCP users): every MCP user debugs *the same* SAP
  user, so a capture can catch a run triggered by another MCP user of that identity. ARC-1 serializes
  captures per SAP user inside one process; across processes SAP's own conflict check refuses a second
  listener. Admins of shared-identity deployments should keep debug off.
- **Same-user Eclipse**: if the developer's Eclipse is listening for the same SAP user, ARC-1 refuses
  (conflict check). Deleting the listener drops the user's server-side external breakpoints; Eclipse
  re-posts its set the next time it starts listening.
- **Work process**: a stop holds the debuggee's work process for at most `timeoutSeconds` + steps;
  the per-call budget and the release path bound it.
- **Many users on one instance** (PP makes debugging available to every MCP user): a capture holds up
  to two SAP request slots (the long poll or the inspection, plus the trigger), so at most
  ⌊`ARC1_MAX_CONCURRENT`/4⌋ captures (min 1) run at once per ARC-1 instance and debugging never takes
  more than half of the slots everyone shares. The cap is per instance; SAP's conflict check still
  serializes one SAP user across instances. Each stop also holds one dialog work process on SAP —
  size `rdisp/wp_no_dia` with that in mind.

## 8. Rejected alternatives

- **Interactive multi-call tools** (VSP/abap-adt-api surface): violates §4.1–4.3.
- **Dynamic logpoints** (`/sap/bc/adt/dlp/logpoints`, A `logpoints.js`): non-blocking and attractive
  for production, but asynchronous (log, then read later) and a different object model — a good
  follow-up, not "the debugger".
- **Classrun trigger** (`IF_OO_ADT_CLASSRUN`): executes arbitrary code, which
  [ADR-0009](../adr/0009-abap-execution-and-rfc-belong-in-extensions.md) keeps out of core (extensions
  only, `ctx.run.classRun` behind `SAP_ALLOW_PLUGIN_EXECUTE` + writes). The capture stays inside that
  boundary: it uses SAP's native debugger resources and no ABAP helper, and its triggers are ABAP Unit
  on tests declared harmless (a native development operation the ADR keeps) and a read-only OData GET.

## 9. Live verification still owed (run before turning it on for real users)

**Done on the BTP ABAP Environment trial (2026-10-23, PP through XSUAA, `trigger=unittest`):** the
session user is the internal `CB99…` user (10); a listening Eclipse is refused with SAP's conflict
text and nothing is armed (4); a line breakpoint in a class method is hit, with stack, named locals
and three `stepOver`s with changing values, then released by `stepContinue` with the unit test
passing (1, BTP only); an exception breakpoint (`CX_SY_ZERODIVIDE`, caught) stops where it is
raised; structures, table rows and structure components across steps read back; the long poll and
trigger ran side by side (7). It took the §3.6 fix: before it, every attach failed with
`invalidDebuggee`. Also seen there: the application servers are pods whose names change over time
(`appserver-t4w2x`/`-rpsxx`, later `-w4krn`), which the runtime discovery absorbs; and once, in the
~75 s after re-activating the class, three line breakpoints on the freshly added method did not stop
although the unit tests ran (no stop at all, not a refused attach) — consistent with the new version
reaching the other application server late (buffer sync, `rdisp/bufreftime`) but not reproduced after a
later activation, so the hint only suggests waiting a minute. `trigger=http` works as well: a line
breakpoint in the query provider of a custom entity, behind a freshly published OData V4 UI binding,
stopped under the SADL / Gateway V4 stack, with the request and response objects readable. For the
first minutes after the publish (which itself outlasted ARC-1's request timeout) the service answered
403 "blocked by UCON"; such a capture reports `trigger failed` with its own hint. Still owed on BTP: a
run long enough to probe the poll timeout under PP (11).

**Only the BTP ABAP Environment has been tested live.** Every other landscape is still owed before the
action is relied on there: SAP S/4HANA on-premise (items 1–10), SAP S/4HANA Cloud Private Edition (the
same checks on its release; it is typically reached through the Cloud Connector, hence also 11) and
SAP S/4HANA Cloud Public Edition (12).

1. 758 + 816: `trigger=unittest` on a class with a line breakpoint → `hit:true`, stack top = the line,
   locals present; verify the `@ROOT` scope names (`CHILD_NAME`) and that the walk returns values.
2. 7.50: same; confirm the stack dispatcher fallback and observe whether the attach survives without
   `abapfs_extensions` (§3.5).
3. `trigger=http` against an OData V4 RAP service with a breakpoint in the behavior pool.
4. Conflict: start Eclipse debugging for the same user → ARC-1 refuses with SAP's conflict text.
5. Cleanup: after every path (hit, timeout, refused breakpoint, trigger error), no `ABDBG_LISTENER`
   row and no ARC-1 breakpoints remain; the trigger request completes.
6. Capture real response bodies into `tests/fixtures/xml/debugger-*.xml` and replace the
   reference-derived fixtures.
7. Parallelism: the long poll and the unit-test/OData trigger share the logon (`SAP_SESSIONID`)
   cookie on the stateless client. Stateless ICF requests of one security session run in parallel
   (Fiori apps rely on it), but confirm the trigger is not queued behind the poll.
8. Stale listener: if a capture is killed before its `finally` runs, its registration may linger
   and the next capture reports a conflict (ARC-1 cannot tell its own stale listener from Eclipse's
   — every capture uses a fresh `ideId`). Observe how long SAP keeps it after the poll returns; if
   it is long, add an explicit "ARC-1-owned" marker (e.g. a fixed `ideId` prefix) and reclaim it.
9. Arm delay: `timings.armDelayMs` in `src/handlers/debug.ts` (1.5 s) assumes SAP registers the listener before the trigger
   reaches the line; measure on a busy system and tune.
10. Session user (§7.3): on 758, 816 and the BTP ABAP Environment, `systeminformation` returns
    `userName` = the logon user; under PP with a mapping where the IdP name differs from the SAP user,
    it returns the **mapped** SAP user. Find the first release that has it (absent on 7.50; 7.51–7.54
    unknown) and record a real body in `tests/fixtures/`.
11. PP through the Cloud Connector: confirm the long poll (`timeoutSeconds` + 30 s) survives the
    connectivity proxy and Cloud Connector timeouts, or lower the maximum `timeoutSeconds` there.
12. SAP S/4HANA Cloud Public Edition: confirm that a developer-extensibility user can arm an external
    breakpoint and attach on the development tenant, that the unit-test trigger runs there, and that
    `systeminformation` names the mapped SAP user under its SAML-based principal propagation.

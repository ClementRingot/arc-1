# ABAP debugger for ARC-1 — one-shot breakpoint capture dossier

> **Evidence level: corroborated, NOT yet live-verified by ARC-1.** No SAP system was reachable from
> the session that produced this dossier (the session's ARC-1 MCP instance failed to connect), so every
> contract fact below comes from three independent client implementations that drive the same SAP
> resources, two of them with recorded live verification. The feature ships **default-off** behind
> `SAP_ALLOW_DEBUG` until the Phase-3/6 live checks in §9 have been run on 7.50, 758 and 816.

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
the release.** ARC-1 already has exactly that primitive: `AdtHttpClient.withStatefulSession()`.

## 3. Verified-by-reference ADT contract

Sources: **A** = abap-adt-api 9.2.0 `build/api/debugger.js` + `AdtClient.js`; **V** = vscode_abap_remote_fs
`debugListener.ts`, `debugService.ts`, `breakpointManager.ts`, `variableManager.ts`; **S** = VSP
`pkg/adt/debugger.go`, `pkg/saprfc/adtdebug.go`, `pkg/saprfc/adtbatch.go`, README (live notes).

### 3.1 Identity triple

Every listener/breakpoint request carries `debuggingMode=user`, `requestUser=<SAP user, upper case>`,
`terminalId`, `ideId` (A, S). In user mode SAP keys the **listener** by user alone — `ABDBG_LISTENER`
holds `IDE_ID=<user>`, `TERMINAL_ID='%_USER'` (S). **`requestUser` must be the real SAP logon user:** an
empty user registers a listener that "matches nothing — it waits out its whole timeout" (S). There is no
on-prem whoami endpoint (`docs/research/issues/636-…`), so ARC-1 can only debug when it knows the user
(§7.3).

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
| Listen | `POST …?debuggingMode=user&requestUser=&terminalId=&ideId=&checkConflict=true&isNotifiedOnConflict=true&timeout=<s>`, `Accept: application/vnd.sap.as+xml` (S). **Long poll**: returns when a debuggee stops, on conflict, or at the server timeout. **Empty body = nobody stopped** (S). A caught debuggee arrives as `<asx:abap><asx:values><DATA><STPDA_DEBUGGEE>` with `DEBUGGEE_ID`, `DEBUGGEE_USER`, `PRG_CURR`, `INCL_CURR`, `LINE_CURR`, `DBGEE_KIND`, `IS_ATTACH_IMPOSSIBLE`, newer releases also `URI`, `TYPE`, `NAME` (A, S). |
| Stop | `DELETE …?debuggingMode=user&requestUser=<USER>` — **by user only**; a DELETE quoting the ids "matches no row" and the registration silently swallows the next debuggee (S, live). Removing it also ends external debugging for the user and drops the user's external breakpoints (S). |

The registration survives the poll's return — it must be deleted explicitly (S). A client that stops
waiting does not stop the server-side poll; it runs to its timeout, so it must not sit on the session
the debugger needs (S). ARC-1 therefore runs the long poll on the **stateless** client (as V does) and
removes the registration through it.

### 3.4 Debug session (one stateful session from attach to release)

| Operation | Request | Notes |
|---|---|---|
| Attach | `POST /sap/bc/adt/debugger?method=attach&debuggeeId=&dynproDebugging=true&debuggingMode=user&requestUser=` | Response `<dbg:attach isSteppingPossible isPostMortem …><reachedBreakpoints><breakpoint id kind/>`. The debuggee is attachable only while it waits — listen → attach must be back-to-back, otherwise `invalidDebuggee` (`CX_ABDBG_ACTEXT_CANNOT_ATTACH`) (S). |
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
| BTP ABAP | Same resources (Eclipse debugs BTP); the internal ABAP user (`CB99…`) is only known after a cloud create (`noteInternalUser`). | ARC-1 |

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

Flow: resolve user → per-user in-process mutex → conflict check → set breakpoints (fresh `ideId`,
full sync) → start the long poll (stateless) → arm delay → start the trigger → race (hit / trigger
finished / timeout) → attach + stack + variables + steps on one `withStatefulSession` → release
(clear session breakpoints, `stepContinue` until ended; `terminateDebuggee` only as last resort) →
always: clear external breakpoints, delete the listener, settle the trigger.

Output (JSON): `hit`, `debuggee`, `breakpoints` (set / refused with SAP's message), `stoppedAt`,
`stack` (customer frames, system frames counted), `variables` (simple values, one level of structure
components, first table rows; values truncated), `steps`, `release`, `trigger` (outcome), `warnings`.

## 6. ARC-1 impact

| Area | Files |
|---|---|
| ADT client | new `src/adt/debugger.ts` (builders, parsers, listener/session ops, release) |
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

`SAP_USER` (Basic auth), else the internal BTP user learned from a cloud create. Principal propagation,
cookie and BTP OAuth sessions without either are **refused with an explicit message** rather than
guessed — an empty or wrong `requestUser` makes the listener silently match nothing.

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

## 8. Rejected alternatives

- **Interactive multi-call tools** (VSP/abap-adt-api surface): violates §4.1–4.3.
- **Dynamic logpoints** (`/sap/bc/adt/dlp/logpoints`, A `logpoints.js`): non-blocking and attractive
  for production, but asynchronous (log, then read later) and a different object model — a good
  follow-up, not "the debugger".
- **Classrun trigger** (`IF_OO_ADT_CLASSRUN`): executes arbitrary code; ARC-1 gates that behind
  `SAP_ALLOW_PLUGIN_EXECUTE` + writes. Unit tests (harmless risk level) and read-only OData GETs are
  the v1 triggers.

## 9. Live verification still owed (run before turning it on for real users)

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

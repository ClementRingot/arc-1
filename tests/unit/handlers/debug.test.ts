/**
 * SAPDiagnose action="debug" — one-shot capture orchestration, end to end through handleToolCall
 * over a real AdtClient and a fake SAP (mocked undici fetch).
 *
 * The SAP answers are REFERENCE-DERIVED (abap-adt-api / vibing-steampunk shapes, see
 * docs/research/2026-10-22-abap-debugger-one-shot-capture.md), not live captures.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { unrestrictedSafetyConfig } from '../../../src/adt/safety.js';
import { DEFAULT_CONFIG } from '../../../src/server/types.js';
import { mockResponse } from '../../helpers/mock-fetch.js';
import { AdtClient, createClient, mockFetch } from './setup-undici-mock.js';

const { handleToolCall } = await import('../../../src/handlers/dispatch.js');
const { setDebugTimingsForTests } = await import('../../../src/handlers/debug.js');

const CONFIG = { ...DEFAULT_CONFIG, allowDataPreview: true, allowDebug: true };

const CLASS_SOURCE = [
  'CLASS zcl_order DEFINITION PUBLIC FINAL CREATE PUBLIC.',
  '  PUBLIC SECTION.',
  '    METHODS get_total RETURNING VALUE(rv_total) TYPE i.',
  'ENDCLASS.',
  '',
  'CLASS zcl_order IMPLEMENTATION.',
  '  METHOD get_total.',
  '    DATA lv_total TYPE i.',
  '    lv_total = 42.',
  '    rv_total = lv_total.',
  '  ENDMETHOD.',
  'ENDCLASS.',
].join('\n');

const DEBUGGEE_XML = `<?xml version="1.0" encoding="utf-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><STPDA_DEBUGGEE><CLIENT>001</CLIENT><DEBUGGEE_ID>DBGEE_42</DEBUGGEE_ID><DEBUGGEE_USER>ADMIN</DEBUGGEE_USER><PRG_CURR>ZCL_ORDER=====================CP</PRG_CURR><INCL_CURR>ZCL_ORDER=====================CM001</INCL_CURR><LINE_CURR>3</LINE_CURR><DBGEE_KIND>DEBUGGEE</DBGEE_KIND><IS_ATTACH_IMPOSSIBLE>false</IS_ATTACH_IMPOSSIBLE></STPDA_DEBUGGEE></DATA></asx:values></asx:abap>`;

const AUNIT_PASSED = `<?xml version="1.0" encoding="utf-8"?><aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit"><program name="ZCL_ORDER"><testClasses><testClass name="LTCL_ORDER" riskLevel="harmless"><testMethods><testMethod name="TOTAL" executionTime="0.1"/></testMethods></testClass></testClasses></program></aunit:runResult>`;

const ENDED = `<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework"><type id="ExceptionResourceFailure"/><message lang="EN">Debuggee ended</message><properties><entry key="com.sap.adt.communicationFramework.subType">debuggeeEnded</entry></properties></exc:exception>`;

function stackXml(line: number): string {
  return `<?xml version="1.0" encoding="utf-8"?><dbg:stack xmlns:dbg="http://www.sap.com/adt/debugger"><stackEntry stackPosition="2" programName="ZCL_ORDER=====================CP" includeName="ZCL_ORDER=====================CM001" line="${line - 6}" eventType="METHOD" eventName="GET_TOTAL" systemProgram="false" uri="/sap/bc/adt/oo/classes/zcl_order/source/main#start=${line},4"/><stackEntry stackPosition="1" programName="SAPLSAUNIT_TEST_RUNNER" includeName="LSAUNIT_TEST_RUNNERU01" line="7" eventType="FUNCTION" eventName="SAUNIT_RUN" systemProgram="true"/></dbg:stack>`;
}

function variable(id: string, metaType: string, value = '', extra = ''): string {
  return `<STPDA_ADT_VARIABLE><ID>${id}</ID><NAME>${id.replace(/^.*[-]/, '')}</NAME><DECLARED_TYPE_NAME>T_${metaType.toUpperCase()}</DECLARED_TYPE_NAME><META_TYPE>${metaType}</META_TYPE><VALUE>${value}</VALUE>${extra}</STPDA_ADT_VARIABLE>`;
}

const asx = (inner: string) =>
  `<?xml version="1.0" encoding="utf-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>${inner}</DATA></asx:values></asx:abap>`;
const hierarchy = (parent: string, child: string, name = child) =>
  `<STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>${parent}</PARENT_ID><CHILD_ID>${child}</CHILD_ID><CHILD_NAME>${name}</CHILD_NAME></STPDA_ADT_VARIABLE_HIERARCHY>`;

const VARIABLES: Record<string, string> = {
  LV_TOTAL: variable('LV_TOTAL', 'simple', '42'),
  LS_HEAD: variable('LS_HEAD', 'structure'),
  LT_ITEMS: variable('LT_ITEMS', 'table', '', '<TABLE_LINES>2</TABLE_LINES>'),
  'LT_ITEMS[1]': variable('LT_ITEMS[1]', 'structure'),
  'LT_ITEMS[2]': variable('LT_ITEMS[2]', 'structure'),
};
const CHILDREN: Record<string, string[]> = {
  '@LOCALS': ['LV_TOTAL', 'LS_HEAD', 'LT_ITEMS'],
  LS_HEAD: ['LS_HEAD-VBELN', 'LS_HEAD-KUNNR'],
  'LT_ITEMS[1]': ['LT_ITEMS[1]-POSNR'],
  'LT_ITEMS[2]': ['LT_ITEMS[2]-POSNR'],
};
const LEAF_VALUES: Record<string, string> = {
  'LS_HEAD-VBELN': '0000004711',
  'LS_HEAD-KUNNR': 'CUST01',
  'LT_ITEMS[1]-POSNR': '000010',
  'LT_ITEMS[2]-POSNR': '000020',
};

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: string;
  stateful: boolean;
}

interface FakeSapOptions {
  /** The listener catches the debuggee (otherwise it waits until aborted, or times out at once). */
  hit?: boolean;
  /** With hit=false: answer the long poll with an empty body immediately (server timeout). */
  listenerTimesOut?: boolean;
  /** Breakpoint lines below this are refused ("no statement"). */
  acceptLinesFrom?: number;
  conflict?: boolean;
  /** SAP refuses breakpoints (the user lacks debug authorization). */
  breakpointsForbidden?: boolean;
}

function installFakeSap(options: FakeSapOptions = {}) {
  const calls: Call[] = [];
  let currentLine = 9;
  let released: () => void = () => {};
  const releasedPromise = new Promise<void>((resolve) => {
    released = resolve;
  });
  let triggered: () => void = () => {};
  const triggeredPromise = new Promise<void>((resolve) => {
    triggered = resolve;
  });

  mockFetch.mockReset();
  mockFetch.mockImplementation(
    async (
      url: string | URL,
      init?: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal },
    ) => {
      const parsed = new URL(String(url));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : '';
      const headers = init?.headers ?? {};
      const call: Call = {
        method,
        path: parsed.pathname,
        query: parsed.searchParams,
        body,
        stateful: headers['X-sap-adt-sessiontype'] === 'stateful',
      };
      calls.push(call);
      const path = parsed.pathname.toLowerCase();
      const q = parsed.searchParams;

      if (method === 'HEAD' && path === '/sap/bc/adt/core/discovery')
        return mockResponse(200, '', { 'x-csrf-token': 'T' });
      if (method === 'GET' && path === '/sap/bc/adt/oo/classes/zcl_order/source/main')
        return mockResponse(200, CLASS_SOURCE);
      if (path === '/sap/bc/adt/debugger/listeners') {
        if (method === 'GET') {
          return options.conflict
            ? mockResponse(
                409,
                ENDED.replace('debuggeeEnded', 'conflictDetected').replace(
                  '</properties>',
                  '<entry key="conflictText">ADMIN is debugged in Eclipse</entry></properties>',
                ),
              )
            : mockResponse(200, '');
        }
        if (method === 'DELETE') return mockResponse(200, '');
        // POST: the long poll.
        if (options.hit) {
          await triggeredPromise;
          return mockResponse(200, DEBUGGEE_XML);
        }
        if (options.listenerTimesOut) return mockResponse(200, '');
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          });
        });
      }
      if (path === '/sap/bc/adt/debugger/breakpoints' && method === 'POST') {
        if (options.breakpointsForbidden) {
          return mockResponse(
            403,
            ENDED.replace('debuggeeEnded', 'notAuthorized').replace('Debuggee ended', 'No authorization to debug'),
          );
        }
        if (body.includes('scope="debugger"'))
          return mockResponse(200, '<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger"/>');
        const items = [...body.matchAll(/clientId="arc1-line-(\d+)"/g)].map((m) => {
          const line = Number(m[1]);
          return line >= (options.acceptLinesFrom ?? 1)
            ? `<breakpoint kind="line" clientId="arc1-line-${line}" id="BP-L${line}" adtcore:uri="/sap/bc/adt/oo/classes/zcl_order/source/main#start=${line}"/>`
            : `<breakpoint kind="line" clientId="arc1-line-${line}" errorMessage="Cannot create a breakpoint at this position"/>`;
        });
        if (body.includes('kind="exception"')) {
          items.push(
            '<breakpoint kind="exception" clientId="arc1-exception" id="BP-EXC" exceptionClass="CX_SY_ZERODIVIDE"/>',
          );
        }
        return mockResponse(
          200,
          `<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger" xmlns:adtcore="http://www.sap.com/adt/core">${items.join('')}</dbg:breakpoints>`,
        );
      }
      if (path.startsWith('/sap/bc/adt/debugger/breakpoints/') && method === 'DELETE') return mockResponse(200, '');
      if (path === '/sap/bc/adt/abapunit/testruns') {
        triggered();
        if (options.hit) await releasedPromise;
        return mockResponse(200, AUNIT_PASSED);
      }
      if (path === '/sap/bc/adt/debugger/stack') return mockResponse(200, stackXml(currentLine));
      if (path === '/sap/bc/adt/debugger') {
        switch (q.get('method')) {
          case 'attach':
            return mockResponse(
              200,
              '<dbg:attach xmlns:dbg="http://www.sap.com/adt/debugger" isSteppingPossible="true"/>',
            );
          case 'stepOver':
            currentLine++;
            return mockResponse(
              200,
              '<dbg:step xmlns:dbg="http://www.sap.com/adt/debugger" isSteppingPossible="true"/>',
            );
          case 'stepContinue':
            released();
            return mockResponse(400, ENDED);
          case 'getChildVariables': {
            const parents = [...body.matchAll(/<PARENT_ID>([^<]+)<\/PARENT_ID>/g)].map((m) => m[1] as string);
            if (parents.includes('@ROOT'))
              return mockResponse(
                200,
                asx(`<HIERARCHIES>${hierarchy('@ROOT', '@LOCALS', 'Locals')}</HIERARCHIES><VARIABLES/>`),
              );
            const rows = parents.flatMap((parent) => (CHILDREN[parent] ?? []).map((child) => hierarchy(parent, child)));
            const vars = parents.flatMap((parent) =>
              (CHILDREN[parent] ?? []).map(
                (child) => VARIABLES[child] ?? variable(child, 'simple', LEAF_VALUES[child] ?? ''),
              ),
            );
            return mockResponse(
              200,
              asx(`<HIERARCHIES>${rows.join('')}</HIERARCHIES><VARIABLES>${vars.join('')}</VARIABLES>`),
            );
          }
          case 'getVariables': {
            const ids = [...body.matchAll(/<ID>([^<]+)<\/ID>/g)].map((m) =>
              (m[1] as string).replace('ME-&gt;', 'ME->'),
            );
            const values = ids.flatMap((id) =>
              id === 'LV_TOTAL'
                ? [variable('LV_TOTAL', 'simple', String(30 + currentLine))]
                : VARIABLES[id]
                  ? [VARIABLES[id]]
                  : [],
            );
            return mockResponse(200, asx(values.join('')));
          }
        }
      }
      if (path.startsWith('/sap/opu/odata4/')) {
        triggered();
        return mockResponse(200, '{"value":[]}');
      }
      if (path === '/sap/bc/adt/repository/informationsystem/search') {
        return mockResponse(
          200,
          '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/ztc_order" adtcore:type="CLAS/OC" adtcore:name="ZTC_ORDER" adtcore:packageName="$TMP"/></adtcore:objectReferences>',
        );
      }
      return mockResponse(404, `unexpected ${method} ${parsed.pathname}${parsed.search}`);
    },
  );
  return { calls };
}

async function debug(args: Record<string, unknown>, client = createClient()) {
  const result = await handleToolCall(client, CONFIG, 'SAPDiagnose', { action: 'debug', ...args });
  const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
  let json: Record<string, any> | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { result, text, json };
}

const named = (calls: Call[], method: string, path: string) =>
  calls.filter((call) => call.method === method && call.path.toLowerCase() === path.toLowerCase());

beforeAll(() => {
  setDebugTimingsForTests({ armDelayMs: 0, triggerSettleMs: 200 });
});

afterEach(() => {
  mockFetch.mockReset();
});

describe('SAPDiagnose action="debug" — a hit', () => {
  it('stops in a method, returns stack + frame variables, then releases and cleans up', async () => {
    const { calls } = installFakeSap({ hit: true, acceptLinesFrom: 9 });
    const { result, json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', method: 'get_total' });

    expect(result.isError).toBeFalsy();
    expect(json).toMatchObject({
      hit: true,
      user: 'ADMIN',
      attached: true,
      breakpoints: [
        { kind: 'line', status: 'set', line: 9, uri: '/sap/bc/adt/oo/classes/zcl_order/source/main#start=9' },
      ],
      stoppedAt: { procedure: 'METHOD GET_TOTAL', line: 3 },
      hiddenSystemFrames: 1,
      release: { released: true, via: 'continue' },
      trigger: { kind: 'unittest', target: 'ABAP Unit CLAS ZCL_ORDER', status: 'completed' },
    });
    expect(json?.stack).toHaveLength(1);
    expect(json?.variables).toEqual([
      { name: 'LV_TOTAL', scope: 'Locals', type: 'T_SIMPLE', kind: 'simple', value: '42' },
      {
        name: 'LS_HEAD',
        scope: 'Locals',
        type: 'T_STRUCTURE',
        kind: 'structure',
        components: { VBELN: '0000004711', KUNNR: 'CUST01' },
      },
      { name: 'LT_ITEMS', scope: 'Locals', type: 'T_TABLE', kind: 'table', lines: 2 },
    ]);

    // Probe: METHOD (7) .. ENDMETHOD (11) in one POST; SAP refused 7-8; a second sync keeps only 9.
    const syncs = named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints').filter((c) =>
      c.body.includes('scope="external"'),
    );
    expect(syncs).toHaveLength(2);
    expect([...syncs[0]!.body.matchAll(/arc1-line-(\d+)/g)].map((m) => m[1])).toEqual(['7', '8', '9', '10', '11']);
    expect([...syncs[1]!.body.matchAll(/arc1-line-(\d+)/g)].map((m) => m[1])).toEqual(['9']);
    expect(syncs[0]!.body).toContain('requestUser="ADMIN"');

    // Listener + breakpoints stateless; attach/stack/variables/release on one stateful session.
    const listen = named(calls, 'POST', '/sap/bc/adt/debugger/listeners')[0]!;
    expect(listen.stateful).toBe(false);
    expect(listen.query.get('requestUser')).toBe('ADMIN');
    expect(listen.query.get('timeout')).toBe('60');
    const sessionCalls = calls.filter(
      (c) => c.path.toLowerCase().startsWith('/sap/bc/adt/debugger') && c.query.get('method'),
    );
    expect(sessionCalls.length).toBeGreaterThan(0);
    expect(sessionCalls.every((c) => c.stateful)).toBe(true);
    expect(named(calls, 'GET', '/sap/bc/adt/debugger/stack')[0]?.stateful).toBe(true);
    // The read used the ACTIVE source.
    expect(named(calls, 'GET', '/sap/bc/adt/oo/classes/ZCL_ORDER/source/main')[0]?.query.get('version')).toBe('active');

    // Cleanup: the external breakpoint by id, then the listener by user only.
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/breakpoints/BP-L9')).toHaveLength(1);
    const stop = named(calls, 'DELETE', '/sap/bc/adt/debugger/listeners');
    expect(stop).toHaveLength(1);
    expect(stop[0]!.query.get('requestUser')).toBe('ADMIN');
    expect(stop[0]!.query.has('ideId')).toBe(false);
  });

  it('reads named variables (table rows, unknown names) and records steps', async () => {
    installFakeSap({ hit: true });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      line: 9,
      variables: ['lv_total', 'LT_ITEMS', 'LV_NOPE'],
      steps: 2,
    });
    expect(json?.hit).toBe(true);
    expect(json?.variables).toEqual([
      { name: 'LV_TOTAL', type: 'T_SIMPLE', kind: 'simple', value: '39' },
      {
        name: 'LT_ITEMS',
        type: 'T_TABLE',
        kind: 'table',
        lines: 2,
        rows: [{ POSNR: '000010' }, { POSNR: '000020' }],
      },
      { name: 'LV_NOPE', kind: 'unknown', error: 'not visible in the stopped frame' },
    ]);
    expect(json?.steps).toEqual([
      expect.objectContaining({ step: 1, line: 4, values: { LV_TOTAL: '40', LT_ITEMS: 'table[2]' } }),
      expect.objectContaining({ step: 2, line: 5, values: { LV_TOTAL: '41', LT_ITEMS: 'table[2]' } }),
    ]);
  });

  it('refuses a second capture for the same SAP user while one is running', async () => {
    installFakeSap({ hit: true });
    const client = createClient();
    const first = debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 }, client);
    const second = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 }, client);
    expect(second.result.isError).toBe(true);
    expect(second.text).toContain('already running');
    expect((await first).json?.hit).toBe(true);
  });
});

describe('SAPDiagnose action="debug" — no hit', () => {
  it('ends the long poll when the unit tests finish first and still cleans up', async () => {
    const { calls } = installFakeSap({ hit: false });
    const { result, json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 });
    expect(result.isError).toBeFalsy();
    expect(json).toMatchObject({
      hit: false,
      reason: 'trigger finished without reaching the breakpoint',
      trigger: { kind: 'unittest', status: 'completed' },
    });
    expect(json?.hint).toContain('coverage=true');
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/breakpoints/BP-L9')).toHaveLength(1);
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/listeners')).toHaveLength(1);
    expect(calls.some((c) => c.query.get('method') === 'attach')).toBe(false);
  });

  it('reports a server-side timeout with trigger="none"', async () => {
    const { calls } = installFakeSap({ hit: false, listenerTimesOut: true });
    const { json } = await debug({ type: 'PROG', name: 'ZREPORT', line: 30, trigger: 'none', timeoutSeconds: 5 });
    expect(json).toMatchObject({ hit: false, reason: 'timeout', trigger: { kind: 'none' } });
    expect(json?.hint).toContain('same user');
    expect(named(calls, 'POST', '/sap/bc/adt/abapunit/testruns')).toHaveLength(0);
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/listeners')[0]?.query.get('timeout')).toBe('5');
  });

  it('refuses to take over another IDE listening for the same user', async () => {
    const { calls } = installFakeSap({ conflict: true });
    const { result, text } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 });
    expect(result.isError).toBe(true);
    expect(text).toContain('ADMIN is debugged in Eclipse');
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints')).toHaveLength(0);
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/listeners')).toHaveLength(0);
  });

  it('reports a line SAP refuses everywhere without starting a listener', async () => {
    const { calls } = installFakeSap({ acceptLinesFrom: 100 });
    const { result, json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 5 });
    expect(result.isError).toBe(true);
    expect(json?.breakpoints).toEqual([
      expect.objectContaining({
        status: 'refused',
        error: 'Cannot create a breakpoint at this position',
        triedLines: [5, 6, 7, 8, 9],
      }),
    ]);
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/listeners')).toHaveLength(0);
  });
});

describe('SAPDiagnose action="debug" — gates and input', () => {
  it('refuses when the SAP logon user is unknown (no requestUser can be sent)', async () => {
    installFakeSap();
    const client = new AdtClient({ baseUrl: 'http://sap:8000', safety: unrestrictedSafetyConfig() });
    const { result, text } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 }, client);
    expect(result.isError).toBe(true);
    expect(text).toContain('SAP logon user is unknown');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('is blocked by the safety ceiling without SAP_ALLOW_DEBUG', async () => {
    installFakeSap();
    const client = new AdtClient({
      baseUrl: 'http://sap:8000',
      username: 'admin',
      password: 'secret',
      safety: { ...unrestrictedSafetyConfig(), allowDebug: false },
    });
    const { result, text } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 }, client);
    expect(result.isError).toBe(true);
    expect(text).toContain('SAP_ALLOW_DEBUG=true');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('validates the breakpoint and keeps debug parameters off other actions', async () => {
    installFakeSap();
    const missing = await debug({ type: 'CLAS', name: 'ZCL_ORDER' });
    expect(missing.result.isError).toBe(true);
    expect(missing.text).toContain('needs a breakpoint');
    const tooLong = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, timeoutSeconds: 600 });
    expect(tooLong.text).toContain('1-240');
    const http = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, trigger: 'http' });
    expect(http.text).toContain('needs url');
    const methodOnProg = await debug({ type: 'PROG', name: 'ZREPORT', method: 'x' });
    expect(methodOnProg.text).toContain('only supported for type="CLAS"');
    const stray = await handleToolCall(createClient(), CONFIG, 'SAPDiagnose', {
      action: 'syntax',
      type: 'CLAS',
      name: 'X',
      steps: 2,
    });
    expect(stray.isError).toBe(true);
    expect(stray.content[0]?.type === 'text' ? stray.content[0].text : '').toContain(
      'only supported for action="debug"',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('only accepts host-relative OData paths for trigger="http"', async () => {
    const { calls } = installFakeSap();
    const { result, text } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      line: 9,
      trigger: 'http',
      url: 'https://evil.example/sap/opu/odata4/x',
    });
    expect(result.isError).toBe(true);
    expect(text).toContain('host-relative OData path');
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints')).toHaveLength(0);
  });

  it('resolves triggerName to its object type before arming', async () => {
    const { calls } = installFakeSap({ hit: false });
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, triggerName: 'ztc_order' });
    expect(json?.trigger).toMatchObject({ target: 'ABAP Unit CLAS ZTC_ORDER' });
    expect(named(calls, 'POST', '/sap/bc/adt/abapunit/testruns')[0]?.body).toContain(
      '/sap/bc/adt/oo/classes/ZTC_ORDER',
    );
  });

  it('surfaces SAP authorization refusals as tool errors without starting a listener', async () => {
    const { calls } = installFakeSap({ breakpointsForbidden: true });
    const { result, text } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 });
    expect(result.isError).toBe(true);
    expect(text).toContain('No authorization to debug');
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/listeners')).toHaveLength(0);
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/listeners')).toHaveLength(0);
  });

  it('runs an OData GET as the trigger', async () => {
    const { calls } = installFakeSap({ hit: false });
    const url = '/sap/opu/odata4/sap/zui_travel/srvd/sap/ztravel/0001/Travel?$top=1';
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, trigger: 'http', url });
    expect(json).toMatchObject({
      hit: false,
      reason: 'trigger finished without reaching the breakpoint',
      trigger: { kind: 'http', target: `GET ${url}`, status: 'completed', result: { statusCode: 200 } },
    });
    const get = calls.find((c) => c.path.startsWith('/sap/opu/odata4/'));
    expect(get?.method).toBe('GET');
    expect(get?.query.get('$top')).toBe('1');
    expect(named(calls, 'POST', '/sap/bc/adt/abapunit/testruns')).toHaveLength(0);
  });
});

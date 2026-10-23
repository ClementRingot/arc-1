/**
 * SAPDiagnose action="debug" schema fragment. Listed only when the server ceiling allows debugger
 * captures, so the default tools/list stays byte-identical (and token-free) for everyone else.
 */

import type { ServerConfig } from '../server/types.js';

/** Debugger captures need SAP_ALLOW_DEBUG and SAP_ALLOW_DATA_PREVIEW (variable values are data). */
export function isDebugActionVisible(config: Pick<ServerConfig, 'allowDebug' | 'allowDataPreview'>): boolean {
  return config.allowDebug && config.allowDataPreview;
}

export const SAPDIAGNOSE_DEBUG_DESCRIPTION =
  '- "debug": one-shot capture of ONE run: breakpoints/line/exceptionClass -> trigger -> per stop: stack + variables (+steps) -> released; request every variable up front. line: 1-based as in SAPRead; timeoutSeconds: wait for the first hit (60, max 240).\n';

export const SAPDIAGNOSE_DEBUG_PROPERTIES: Record<string, unknown> = {
  breakpoints: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        name: { type: 'string' },
        line: { type: 'number' },
        method: { type: 'string' },
        include: { type: 'string' },
        hits: { type: 'number' },
      },
    },
    description:
      'debug: stops in this run (max 6): line|method (CLAS: get_total, lhc_x~check), include (implementations|testclasses; auto for lhc_/lcl_/ltc_), hits (1-10, for loops); type/name default to the top-level.',
  },
  exceptionClass: { type: 'string', description: 'debug: stop where this exception class is raised.' },
  trigger: {
    type: 'string',
    enum: ['unittest', 'http', 'none'],
    description:
      'debug: unittest (default: harmless ABAP Unit of triggerName or the breakpoint object), http (GET url), none (you run it, same SAP user).',
  },
  triggerName: { type: 'string', description: 'debug: unit-test CLAS/PROG/FUGR, if not the breakpoint object.' },
  variables: {
    type: 'array',
    items: { type: 'string' },
    description: 'debug: read at each stop/step (LV_X, LS_S-F, LT_T, ME->MV_A); default: frame variables.',
  },
  steps: { type: 'number', description: 'debug: steps after each stop (0-20).' },
  stepMode: { type: 'string', enum: ['over', 'into', 'out'], description: 'debug: how steps move (default over).' },
};

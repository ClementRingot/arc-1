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
  '- "debug": one-shot debugger capture: breakpoint (type+name+line|method, and/or exceptionClass) → trigger → stack + variables at the stop (+steps) → released; nothing stays stopped, so request every variable up front. line: 1-based, as SAPRead numbers it; timeoutSeconds: wait for the hit (60, max 240).\n';

export const SAPDIAGNOSE_DEBUG_PROPERTIES: Record<string, unknown> = {
  method: { type: 'string', description: 'debug: CLAS method instead of line (get_total, lhc_x~check).' },
  include: {
    type: 'string',
    enum: ['implementations', 'testclasses'],
    description: 'debug: CLAS include of line (auto for lhc_/lcl_/ltc_ methods).',
  },
  exceptionClass: { type: 'string', description: 'debug: stop where this exception class is raised.' },
  trigger: {
    type: 'string',
    enum: ['unittest', 'http', 'none'],
    description:
      'debug: unittest (default; harmless ABAP Unit of triggerName, else the breakpoint object), http (GET url), none (you run it as the same SAP user).',
  },
  triggerName: { type: 'string', description: 'debug: unit-test CLAS/PROG/FUGR, if not the breakpoint object.' },
  variables: {
    type: 'array',
    items: { type: 'string' },
    description: 'debug: read at the stop and per step (LV_X, LS_S-F, LT_T, ME->MV_A); default: frame variables.',
  },
  steps: { type: 'number', description: 'debug: stepOver count after the stop (0-20).' },
};

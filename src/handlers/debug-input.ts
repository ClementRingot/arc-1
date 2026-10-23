/**
 * SAPDiagnose action="debug" input: its Zod fields and cross-field rules. The JSON schema the model
 * sees lives in tools-debug.ts and is listed only when the server allows debugger captures.
 */

import { z } from 'zod';

/** The debug-only parameters, spread into SAPDiagnoseSchema. */
export const DEBUG_INPUT_FIELDS = {
  method: z.string().max(128).optional(),
  include: z.enum(['implementations', 'testclasses']).optional(),
  exceptionClass: z
    .string()
    .regex(/^[A-Za-z0-9_/]{1,30}$/, 'exceptionClass must be an ABAP class name')
    .optional(),
  trigger: z.enum(['unittest', 'http', 'none']).optional(),
  triggerName: z.string().max(40).optional(),
  variables: z.array(z.string().min(1).max(200)).max(20).optional(),
  steps: z.coerce.number().int().min(0).max(20).optional(),
};

const DEBUG_ONLY_FIELDS = [
  'method',
  'include',
  'exceptionClass',
  'trigger',
  'triggerName',
  'variables',
  'steps',
] as const;

/** Cross-field rules for SAPDiagnose action="debug" (and its parameters on other actions). */
export function refineDebugInput(
  input: {
    action: string;
    name?: string;
    type?: string;
    line?: number;
    url?: string;
    timeoutSeconds?: number;
  } & Partial<Record<(typeof DEBUG_ONLY_FIELDS)[number], unknown>>,
  ctx: z.RefinementCtx,
): void {
  if (input.action !== 'debug') {
    for (const field of DEBUG_ONLY_FIELDS) {
      if (input[field] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `SAPDiagnose ${field} is only supported for action="debug".`,
        });
      }
    }
    return;
  }
  const type = input.type?.toUpperCase().split('/')[0] ?? '';
  if (input.line === undefined && input.method === undefined && input.exceptionClass === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['line'],
      message:
        'SAPDiagnose action="debug" needs a breakpoint: line or method (with type + name), and/or exceptionClass.',
    });
  }
  if (input.line !== undefined && (!Number.isInteger(input.line) || input.line < 1)) {
    ctx.addIssue({ code: 'custom', path: ['line'], message: 'debug line must be a positive integer (1-based).' });
  }
  if ((input.line !== undefined || input.method !== undefined) && (!input.name || !type)) {
    ctx.addIssue({
      code: 'custom',
      path: ['name'],
      message: 'debug line/method breakpoints need type (CLAS, PROG or FUNC) and name.',
    });
  }
  if ((input.method !== undefined || input.include !== undefined) && type !== 'CLAS') {
    ctx.addIssue({
      code: 'custom',
      path: [input.method !== undefined ? 'method' : 'include'],
      message: 'debug method/include are only supported for type="CLAS".',
    });
  }
  if (input.trigger === 'http' && !input.url) {
    ctx.addIssue({
      code: 'custom',
      path: ['url'],
      message: 'debug trigger="http" needs url (a host-relative OData path).',
    });
  }
  if (input.timeoutSeconds !== undefined && input.timeoutSeconds > 240) {
    ctx.addIssue({ code: 'custom', path: ['timeoutSeconds'], message: 'debug timeoutSeconds must be 1-240.' });
  }
}

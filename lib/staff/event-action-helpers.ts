import "server-only";
import { back, fail } from "./action-helpers";
import { classifyEventError, type EventOkCode } from "./events";

/** Like `fail`, but an events refusal gets its own wording first. The shared classifier handles everything else. */
export function failEvent(path: string, message: string): never {
  const code = classifyEventError(message);
  if (code) return back(path, { err: code });
  return fail(path, message);
}

/** Redirects back with an events success code. */
export const okEvent = (path: string, code: EventOkCode): never => back(path, { ok: code });

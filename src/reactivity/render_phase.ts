/**
 * The DEV probe for "is React rendering right now?", read off the hooks dispatcher: its members throw everywhere
 * except render, which is what separates a render from an effect.
 */

import * as React from 'react';

const SHARED_INTERNALS_KEY = '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE';

const HOOKS_UNAVAILABLE = 'throwInvalidHookError';

type HooksDispatcher = { useMemo?: (...args: never[]) => unknown };

function isRendering(): boolean {
  const internals = (React as unknown as Record<string, { H?: HooksDispatcher | null } | undefined>)[SHARED_INTERNALS_KEY];
  const dispatcher = internals?.H;
  if (!dispatcher) return false;
  return dispatcher.useMemo?.name !== HOOKS_UNAVAILABLE;
}

/** A `\n    at <Component>` chain for the component rendering now, or `null` outside render and in production. */
export function renderPhaseOwnerStack(): string | null {
  if (!isRendering()) return null;
  const capture = (React as unknown as { captureOwnerStack?: () => string | null }).captureOwnerStack;
  return typeof capture === 'function' ? capture() : null;
}

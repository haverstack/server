import type { TokenSession } from '@haverstack/core/wire';
import type { RequestScope } from './lib/scope.js';

/** Hono context variable map shared across all route files. */
export type AppEnv = {
  Variables: {
    auth: TokenSession | null;
    /**
     * The view every request is served through: the session's, or the
     * anonymous one. Set once by authMiddleware. ScopedStack decides each
     * request a session makes, so a route asks it rather than deciding
     * ownership or permission itself. See docs/spec/access-control.md
     * § Serving requests.
     */
    scope: RequestScope;
    requestId: string;
  };
};

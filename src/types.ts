/** Hono context variable map shared across all route files. */
export type AppEnv = {
  Variables: {
    auth: { entityId: string } | null;
    requestId: string;
  };
};

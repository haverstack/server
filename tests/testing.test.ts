import { describe, it, expect } from 'vitest';
import { startTestServer, TEST_TOKEN } from '../src/testing.js';

describe('startTestServer', () => {
  it('actually listens: discovery and an authenticated round trip work over real HTTP', async () => {
    const server = await startTestServer();
    try {
      const discovery = await fetch(`${server.url}/.well-known/stack`);
      expect(discovery.status).toBe(200);
      const body = (await discovery.json()) as { entityId: string };
      expect(body.entityId).toBe(server.ctx.stack.ownerEntityId);

      const created = await fetch(`${server.url}/types`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(created.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('close() releases the port and the temp db', async () => {
    const server = await startTestServer();
    const { url } = server;
    await server.close();
    await expect(fetch(`${url}/.well-known/stack`)).rejects.toThrow();
  });
});

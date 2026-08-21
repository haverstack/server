import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateDidKeypair } from '@haverstack/core/did';
import { signAuthChallenge, base64urlEncode } from '@haverstack/core/wire';
import type { DidKeypair } from '@haverstack/core/did';
import {
  buildTestApp,
  req,
  TEST_BASE_URL,
  TEST_TOKEN,
  OTHER_ENTITY_ID,
  type TestApp,
} from '../setup.js';

async function challengeAndSign(
  t: TestApp,
  keypair: DidKeypair,
  opts: { origin?: string; overrideNonce?: string } = {},
) {
  const { data } = await req(t.app, 'POST', '/auth/challenge', {
    body: { did: keypair.did },
  });
  const { nonce } = data as { nonce: string; expiresAt: string };
  const signedNonce = opts.overrideNonce ?? nonce;
  const signature = await signAuthChallenge(keypair.privateKey, {
    origin: opts.origin ?? TEST_BASE_URL,
    did: keypair.did,
    nonce: signedNonce,
  });
  return { nonce: signedNonce, signature: base64urlEncode(signature) };
}

describe('POST /auth/challenge', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('issues a nonce for a well-formed DID, unauthenticated', async () => {
    const keypair = await generateDidKeypair();
    const { status, data } = await req(t.app, 'POST', '/auth/challenge', {
      body: { did: keypair.did },
    });
    expect(status).toBe(200);
    const d = data as { nonce: string; expiresAt: string };
    expect(d.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new Date(d.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('issues a fresh, distinct nonce on each call', async () => {
    const keypair = await generateDidKeypair();
    const first = await req(t.app, 'POST', '/auth/challenge', { body: { did: keypair.did } });
    const second = await req(t.app, 'POST', '/auth/challenge', { body: { did: keypair.did } });
    expect((first.data as { nonce: string }).nonce).not.toBe(
      (second.data as { nonce: string }).nonce,
    );
  });

  it('rejects a malformed DID with 400 invalid_did', async () => {
    const { status, data } = await req(t.app, 'POST', '/auth/challenge', {
      body: { did: 'not-a-did' },
    });
    expect(status).toBe(400);
    expect((data as { error: { code: string } }).error.code).toBe('invalid_did');
  });

  it('rejects a missing did with 400 invalid_did', async () => {
    const { status, data } = await req(t.app, 'POST', '/auth/challenge', { body: {} });
    expect(status).toBe(400);
    expect((data as { error: { code: string } }).error.code).toBe('invalid_did');
  });
});

describe('POST /auth/token', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('issues an undelegated bearer token for a valid handshake', async () => {
    const keypair = await generateDidKeypair();
    const { nonce, signature } = await challengeAndSign(t, keypair);

    const { status, data } = await req(t.app, 'POST', '/auth/token', {
      body: { did: keypair.did, nonce, signature },
    });
    expect(status).toBe(200);
    const d = data as {
      token: string;
      expiresAt?: string;
      principalId: string;
      subjectId: string;
    };
    expect(typeof d.token).toBe('string');
    expect(d.principalId).toBe(keypair.did);
    expect(d.subjectId).toBe(keypair.did);

    // The issued token actually authenticates as that DID.
    const session = await t.ctx.tokens.lookupToken(d.token);
    expect(session).toEqual({ principalId: keypair.did, subjectId: keypair.did });
  });

  it('never lets the client name its own subject, even if it tries', async () => {
    const keypair = await generateDidKeypair();
    const { nonce, signature } = await challengeAndSign(t, keypair);

    const { status, data } = await req(t.app, 'POST', '/auth/token', {
      body: {
        did: keypair.did,
        nonce,
        signature,
        onBehalfOf: 'did:key:someone-else',
        subjectId: 'did:key:someone-else',
      },
    });
    expect(status).toBe(200);
    const d = data as { principalId: string; subjectId: string };
    expect(d.principalId).toBe(keypair.did);
    expect(d.subjectId).toBe(keypair.did);
  });

  it('is single-use: redeeming the same nonce twice fails the second time', async () => {
    const keypair = await generateDidKeypair();
    const { nonce, signature } = await challengeAndSign(t, keypair);

    const first = await req(t.app, 'POST', '/auth/token', {
      body: { did: keypair.did, nonce, signature },
    });
    expect(first.status).toBe(200);

    const second = await req(t.app, 'POST', '/auth/token', {
      body: { did: keypair.did, nonce, signature },
    });
    expect(second.status).toBe(401);
    expect((second.data as { error: { code: string } }).error.code).toBe('unknown_nonce');
  });

  it('rejects a nonce that was never issued with 401 unknown_nonce', async () => {
    const keypair = await generateDidKeypair();
    const signature = await signAuthChallenge(keypair.privateKey, {
      origin: TEST_BASE_URL,
      did: keypair.did,
      nonce: 'never-issued-nonce',
    });
    const { status, data } = await req(t.app, 'POST', '/auth/token', {
      body: {
        did: keypair.did,
        nonce: 'never-issued-nonce',
        signature: base64urlEncode(signature),
      },
    });
    expect(status).toBe(401);
    expect((data as { error: { code: string } }).error.code).toBe('unknown_nonce');
  });

  it('rejects a nonce bound to a different DID with 401 unknown_nonce, not invalid_signature', async () => {
    const owner = await generateDidKeypair();
    const impostor = await generateDidKeypair();
    // Challenge is issued to `owner`, but `impostor` signs it correctly
    // with its own key over the same nonce and origin.
    const { data } = await req(t.app, 'POST', '/auth/challenge', { body: { did: owner.did } });
    const { nonce } = data as { nonce: string };
    const signature = await signAuthChallenge(impostor.privateKey, {
      origin: TEST_BASE_URL,
      did: impostor.did,
      nonce,
    });

    const { status, data: body } = await req(t.app, 'POST', '/auth/token', {
      body: { did: impostor.did, nonce, signature: base64urlEncode(signature) },
    });
    expect(status).toBe(401);
    expect((body as { error: { code: string } }).error.code).toBe('unknown_nonce');
  });

  it('rejects an expired nonce with 401 expired_nonce', async () => {
    const keypair = await generateDidKeypair();
    const nonce = 'seeded-expired-nonce';
    t.ctx.nonces.seedForTesting(nonce, keypair.did, new Date(Date.now() - 1000));
    const signature = await signAuthChallenge(keypair.privateKey, {
      origin: TEST_BASE_URL,
      did: keypair.did,
      nonce,
    });

    const { status, data } = await req(t.app, 'POST', '/auth/token', {
      body: { did: keypair.did, nonce, signature: base64urlEncode(signature) },
    });
    expect(status).toBe(401);
    expect((data as { error: { code: string } }).error.code).toBe('expired_nonce');
  });

  it('rejects a well-formed but wrong signature with 401 invalid_signature', async () => {
    const signer = await generateDidKeypair();
    const { nonce, signature } = await challengeAndSign(t, signer);
    // Corrupt the signature bytes while keeping it syntactically valid
    // base64url and the right length — still claims `signer`'s DID and the
    // nonce issued to it, so this pins verification failure specifically,
    // distinct from the DID-binding case above.
    const { status, data } = await req(t.app, 'POST', '/auth/token', {
      body: { did: signer.did, nonce, signature: signature.slice(0, -4) + 'AAAA' },
    });
    expect(status).toBe(401);
    expect((data as { error: { code: string } }).error.code).toBe('invalid_signature');
  });

  it('rejects a malformed (non-base64url) signature with 401 invalid_signature', async () => {
    const keypair = await generateDidKeypair();
    const { data } = await req(t.app, 'POST', '/auth/challenge', { body: { did: keypair.did } });
    const { nonce } = data as { nonce: string };

    const { status, data: body } = await req(t.app, 'POST', '/auth/token', {
      body: { did: keypair.did, nonce, signature: 'not+valid/base64url==' },
    });
    expect(status).toBe(401);
    expect((body as { error: { code: string } }).error.code).toBe('invalid_signature');
  });

  it('rejects a malformed DID with 400 invalid_did before touching the nonce store', async () => {
    const { status, data } = await req(t.app, 'POST', '/auth/token', {
      body: { did: 'not-a-did', nonce: 'x', signature: 'y' },
    });
    expect(status).toBe(400);
    expect((data as { error: { code: string } }).error.code).toBe('invalid_did');
  });

  it('builds the signed origin from server config, not a client-supplied Host header', async () => {
    const keypair = await generateDidKeypair();
    // Signed for the server's real configured origin (TEST_BASE_URL) while
    // the request lies about its Host — must still succeed, since the
    // server never derives the origin from the header.
    const { nonce, signature } = await challengeAndSign(t, keypair);
    const { status } = await req(t.app, 'POST', '/auth/token', {
      body: { did: keypair.did, nonce, signature },
      headers: { Host: 'evil.example.com', 'X-Forwarded-Host': 'evil.example.com' },
    });
    expect(status).toBe(200);
  });

  it('rejects a signature scoped to a different origin even if a client claims it via headers', async () => {
    const keypair = await generateDidKeypair();
    // Signed for an origin that is *not* this server's configured one.
    const { nonce, signature } = await challengeAndSign(t, keypair, {
      origin: 'https://attacker.example.com',
    });
    const { status, data } = await req(t.app, 'POST', '/auth/token', {
      body: { did: keypair.did, nonce, signature },
      headers: { Host: 'attacker.example.com', 'X-Forwarded-Host': 'attacker.example.com' },
    });
    expect(status).toBe(401);
    expect((data as { error: { code: string } }).error.code).toBe('invalid_signature');
  });
});

describe('handshake input hardening', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  // A DID whose method core cannot verify can never redeem the nonce a
  // challenge would issue, so issuing one is pure storage spent on a
  // handshake guaranteed to fail. Refused up front instead.
  it.each(['did:web:example.com', 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'])(
    'refuses to issue a challenge for a non-did:key DID (%s)',
    async (did) => {
      const { status, data } = await req(t.app, 'POST', '/auth/challenge', { body: { did } });
      expect(status).toBe(400);
      expect((data as { error: { code: string } }).error.code).toBe('invalid_did');
    },
  );

  // The generic DID grammar has no length bound, so without one an
  // unauthenticated caller writes a body-limit's worth of "DID" into a
  // nonce row per request, retained for the nonce TTL.
  it('refuses an oversized DID and stores nothing for it', async () => {
    const { status } = await req(t.app, 'POST', '/auth/challenge', {
      body: { did: 'did:key:z' + 'a'.repeat(500_000) },
    });
    expect(status).toBe(400);
    const rows = (
      t.ctx.nonces as unknown as {
        db: { prepare(sql: string): { get(): { n: number } } };
      }
    ).db
      .prepare('SELECT COUNT(*) AS n FROM nonces')
      .get();
    expect(rows.n).toBe(0);
    // Tight timeout on purpose: refusing this rests on core screening the
    // length before it decodes, and a lost screen surfaces as a hang rather
    // than a wrong answer.
  }, 5_000);

  // `null` is valid JSON but not a readable body: indexing a field off it
  // throws a bare TypeError, which surfaces as an unlabeled 500 — on an
  // unauthenticated route.
  it.each(['/auth/challenge', '/auth/token'])(
    'answers 400, not 500, for a non-object JSON body (%s)',
    async (path) => {
      const res = await t.app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'null',
      });
      expect(res.status).toBe(400);
    },
  );
});

describe('handshake token bookkeeping', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  // Without a label the owner's only view of what exists cannot tell a
  // self-service token from one they minted deliberately.
  it('labels handshake-issued tokens so the owner can tell them apart', async () => {
    const keypair = await generateDidKeypair();
    const { nonce, signature } = await challengeAndSign(t, keypair);
    await req(t.app, 'POST', '/auth/token', { body: { did: keypair.did, nonce, signature } });

    const { data } = await req(t.app, 'GET', '/tokens', { token: TEST_TOKEN });
    const rows = (data as { tokens: Array<{ principalId: string; label: string | null }> }).tokens;
    const issued = rows.find((r) => r.principalId === keypair.did);
    expect(issued?.label).toBe('did-challenge');
  });

  // lookupToken() refuses an expired token but never deletes the row, and
  // nothing else does either — so an unauthenticated route that mints one
  // per call grows the table without bound.
  it('reclaims expired token rows rather than letting them accumulate', async () => {
    await t.ctx.tokens.createToken(OTHER_ENTITY_ID, { expiresAt: new Date(Date.now() - 1000) });
    expect((await t.ctx.tokens.listTokens()).length).toBe(1);

    const keypair = await generateDidKeypair();
    const { nonce, signature } = await challengeAndSign(t, keypair);
    await req(t.app, 'POST', '/auth/token', { body: { did: keypair.did, nonce, signature } });

    const remaining = await t.ctx.tokens.listTokens();
    expect(remaining.map((r) => r.principalId)).toEqual([keypair.did]);
  });

  // The redeem is one DELETE ... RETURNING rather than a SELECT then a
  // DELETE; the DID predicate sits in the WHERE clause precisely so a
  // mismatched attempt still spends nothing.
  it('does not let a wrong-DID attempt burn a nonce the rightful holder still needs', async () => {
    const owner = await generateDidKeypair();
    const impostor = await generateDidKeypair();
    const { data } = await req(t.app, 'POST', '/auth/challenge', { body: { did: owner.did } });
    const { nonce } = data as { nonce: string };

    const impostorSig = await signAuthChallenge(impostor.privateKey, {
      origin: TEST_BASE_URL,
      did: impostor.did,
      nonce,
    });
    const attempt = await req(t.app, 'POST', '/auth/token', {
      body: { did: impostor.did, nonce, signature: base64urlEncode(impostorSig) },
    });
    expect(attempt.status).toBe(401);

    const ownerSig = await signAuthChallenge(owner.privateKey, {
      origin: TEST_BASE_URL,
      did: owner.did,
      nonce,
    });
    const { status } = await req(t.app, 'POST', '/auth/token', {
      body: { did: owner.did, nonce, signature: base64urlEncode(ownerSig) },
    });
    expect(status).toBe(200);
  });
});

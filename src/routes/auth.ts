import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { verifyAuthChallenge, base64urlDecode } from '@haverstack/core/wire';
import { isValidDid } from '@haverstack/core/did';
import { WIRE_AUTH_ERROR_STATUS } from '@haverstack/wire-types';
import type {
  AuthChallengeRequest,
  AuthChallengeResponse,
  AuthTokenRequest,
  AuthTokenResponse,
  WireAuthErrorCode,
} from '@haverstack/wire-types';
import type { Context } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { readJson } from '../lib/json.js';

// The handshake never issues a delegated token — proving key possession
// proves the principal and nothing about whom it may act for (see #54's
// docs/spec quote). A default TTL, since AuthTokenResponse.expiresAt is a
// concrete value in the conformance fixtures, not an absent field: unlike
// the owner's POST /tokens (which leaves expiry to the owner's choice),
// self-service handshake tokens get a bounded lifetime by default.
const AUTH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `{ error: { code, message } }` for the four handshake-specific codes,
 * deliberately outside WireErrorCode — no Stack operation has begun at
 * this point, so none of these maps to a StackError. See
 * docs/spec/wire-format.md § Authentication.
 */
function authError(c: Context<AppEnv>, code: WireAuthErrorCode, message: string): Response {
  return c.json({ error: { code, message } }, WIRE_AUTH_ERROR_STATUS[code] as ContentfulStatusCode);
}

export function authRoutes(ctx: StackContext, authOrigin: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // POST /auth/challenge — issues a nonce bound to the requested DID.
  // Unauthenticated: this is how a token is earned in the first place.
  app.post('/challenge', async (c) => {
    const body = await readJson<Partial<AuthChallengeRequest>>(c);
    if (typeof body.did !== 'string' || !isValidDid(body.did)) {
      return authError(c, 'invalid_did', 'Not a valid DID');
    }
    const { nonce, expiresAt } = ctx.nonces.issue(body.did);
    const response: AuthChallengeResponse = { nonce, expiresAt: expiresAt.toISOString() };
    return c.json(response);
  });

  // POST /auth/token — redeems a signed nonce for a bearer token.
  // Unauthenticated for the same reason.
  app.post('/token', async (c) => {
    const body = await readJson<Partial<AuthTokenRequest>>(c);
    if (typeof body.did !== 'string' || !isValidDid(body.did)) {
      return authError(c, 'invalid_did', 'Not a valid DID');
    }
    // Checked ahead of the signature so a nonce issued to a different DID
    // is refused as unknown_nonce even when the caller's own signature over
    // it is perfectly valid — the nonce belongs to the DID it was issued
    // for, not to whoever can produce a valid signature.
    if (typeof body.nonce !== 'string') {
      return authError(c, 'unknown_nonce', 'Unknown or already-used nonce');
    }
    if (typeof body.signature !== 'string') {
      return authError(c, 'invalid_signature', 'Signature does not verify');
    }

    // Spent on this call regardless of what happens next — single-use
    // means a redemption attempt consumes the nonce, not merely a
    // successful one.
    const result = ctx.nonces.redeem(body.did, body.nonce);
    if (result === 'unknown') return authError(c, 'unknown_nonce', 'Unknown or already-used nonce');
    if (result === 'expired') return authError(c, 'expired_nonce', 'Challenge has expired');

    let signatureBytes: Uint8Array;
    try {
      signatureBytes = base64urlDecode(body.signature);
    } catch {
      return authError(c, 'invalid_signature', 'Signature does not verify');
    }

    // Built from our own configured public origin (authOrigin), never from
    // a request header — Host/X-Forwarded-Host are client-controlled, and
    // deriving the signed origin from either would let a client choose
    // which origin it signs for, silently reopening the relay attack the
    // origin binding exists to prevent.
    const verified = await verifyAuthChallenge(
      { origin: authOrigin, did: body.did, nonce: body.nonce },
      signatureBytes,
    ).catch(() => false);
    if (!verified) return authError(c, 'invalid_signature', 'Signature does not verify');

    // Undelegated by construction: principalId and subjectId are both the
    // proven DID. Never let a client name its own subject.
    const expiresAt = new Date(Date.now() + AUTH_TOKEN_TTL_MS);
    const { id, token } = await ctx.tokens.createToken(body.did, { expiresAt });
    // Read the row back rather than trusting the value just computed — the
    // store is the source of truth, same reasoning as POST /tokens.
    const stored = (await ctx.tokens.listTokens()).find((t) => t.id === id)!;
    const response: AuthTokenResponse = {
      token,
      expiresAt: stored.expiresAt?.toISOString(),
      principalId: body.did,
      subjectId: body.did,
    };
    return c.json(response);
  });

  return app;
}

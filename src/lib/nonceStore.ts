import { DatabaseSync } from 'node:sqlite';
import { base64urlEncode } from '@haverstack/core/wire';

// Matches the ~5-minute issued→expires gap in the handshake conformance
// fixtures (@haverstack/conformance-fixtures' authChallengeFixtures).
const NONCE_TTL_MS = 5 * 60 * 1000;
// 18 raw bytes base64url-encodes to 24 characters — short, opaque, and
// comfortably unguessable for a value that's live for minutes, not stored
// long-term like a token.
const NONCE_BYTES = 18;

/** Conventional sibling path for the nonce store beside a stack's main .db file. */
export const defaultNonceStorePath = (dbPath: string): string => `${dbPath}.nonces`;

export type NonceRedeemResult = 'ok' | 'unknown' | 'expired';

/**
 * Single-use, DID-bound nonces for the DID challenge–response handshake
 * (POST /auth/challenge, POST /auth/token). Core verifies signatures but
 * deliberately doesn't run a server, so nonce storage, single-use
 * enforcement, and DID binding are this server's own to implement — see
 * docs/spec/wire-format.md § Authentication.
 *
 * Kept beside the token store (its own sibling file) rather than in the
 * portable stack file or in memory, so a restart doesn't silently make
 * every in-flight handshake unrecoverable. node:sqlite, like
 * NativeTokenStore — no extra dependency.
 */
export class AuthNonceStore {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): AuthNonceStore {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(
      `CREATE TABLE IF NOT EXISTS nonces (
        nonce TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        expiresAt INTEGER NOT NULL
      );`,
    );
    // sweepExpired() runs on every issue(), and POST /auth/challenge is
    // unauthenticated — without this the sweep is a full table scan whose
    // cost rises with the issue rate, so the endpoint would pay more the
    // harder it is hit.
    db.exec('CREATE INDEX IF NOT EXISTS idx_nonces_expiresAt ON nonces (expiresAt);');
    return new AuthNonceStore(db);
  }

  issue(did: string): { nonce: string; expiresAt: Date } {
    this.sweepExpired();
    const nonce = base64urlEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS);
    this.db
      .prepare('INSERT INTO nonces (nonce, did, expiresAt) VALUES (?, ?, ?)')
      .run(nonce, did, expiresAt.getTime());
    return { nonce, expiresAt };
  }

  /**
   * Checks and spends a nonce in one step — single-use means a redemption
   * consumes it regardless of outcome, not merely observes it. A missing
   * nonce and one bound to a different DID both report 'unknown': a server
   * MUST NOT let a caller distinguish never-issued from already-spent, or
   * spent-by-someone-else, since the difference only tells an attacker
   * something.
   *
   * One `DELETE ... RETURNING` rather than a SELECT then a DELETE: the pair
   * is only indivisible because DatabaseSync is synchronous and nothing
   * awaits between the two statements, an invariant nothing in the file
   * states and a later refactor would quietly break. The `did` predicate
   * lives in the WHERE clause so a mismatch still deletes nothing, exactly
   * as the two-statement form behaved.
   */
  redeem(did: string, nonce: string): NonceRedeemResult {
    const row = this.db
      .prepare('DELETE FROM nonces WHERE nonce = ? AND did = ? RETURNING expiresAt')
      .get(nonce, did) as { expiresAt: number } | undefined;
    if (!row) return 'unknown';
    if (Date.now() > row.expiresAt) return 'expired';
    return 'ok';
  }

  /**
   * Seeds a nonce with a caller-chosen value rather than a random one.
   * Production code never needs this — issue() is the only way a nonce is
   * meant to come into existence — but a conformance fixture carrying a
   * real signature is signed over one exact, fixed nonce value, so tests
   * need a way to get that value into the store directly. Named for what
   * it is so no production call site can reach for it without saying so.
   */
  seedForTesting(nonce: string, did: string, expiresAt: Date): void {
    this.db
      .prepare('INSERT OR REPLACE INTO nonces (nonce, did, expiresAt) VALUES (?, ?, ?)')
      .run(nonce, did, expiresAt.getTime());
  }

  private sweepExpired(): void {
    this.db.prepare('DELETE FROM nonces WHERE expiresAt < ?').run(Date.now());
  }

  close(): void {
    this.db.close();
  }
}

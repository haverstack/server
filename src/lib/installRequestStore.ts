import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AppManifest, EntityId } from '@haverstack/core';
import { canonicalJson } from './canonicalJson.js';

// Any key that completes the handshake can ask, so a request no one
// re-sends must not be kept forever. Re-sending refreshes it, and an app
// waiting on approval re-sends to check, so this bounds abandoned
// requests rather than live ones. Matches the handshake token's lifetime.
const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Conventional sibling path for the install request store beside a stack's main .db file. */
export const defaultInstallRequestStorePath = (dbPath: string): string => `${dbPath}.installs`;

export type InstallRequestEntry = {
  /** Names this manifest as sent; a key sending a different one gets a new id. */
  id: string;
  /** The key asking to be installed — the session's principal. */
  did: EntityId;
  manifest: AppManifest;
  requestedAt: Date;
  expiresAt: Date;
};

type Row = { id: string; did: string; manifest: string; requestedAt: number; expiresAt: number };

/**
 * Install requests awaiting the owner, one per key: the app's half of an
 * install (POST /installs) leaves one here, and the owner's half
 * (/installs/requests) reviews and approves it. A request is not an
 * approval, so it lives with the server rather than in the stack — a key
 * that merely authenticated writes nothing into the owner's data. Its own
 * sibling file, like AuthNonceStore. See docs/spec/apps.md § Over the wire.
 */
export class InstallRequestStore {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): InstallRequestStore {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(
      `CREATE TABLE IF NOT EXISTS install_requests (
        did TEXT PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        manifest TEXT NOT NULL,
        requestedAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL
      );`,
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_install_requests_expiresAt ON install_requests (expiresAt);',
    );
    return new InstallRequestStore(db);
  }

  /**
   * Records `manifest` as `did`'s pending request, replacing any other it
   * had. Re-sending the same manifest — compared as canonical JSON, so key
   * order is not a difference — keeps its id and refreshes its expiry, so
   * an id the owner reviewed always names what they reviewed.
   */
  put(did: EntityId, manifest: AppManifest): InstallRequestEntry {
    this.sweepExpired();
    const json = canonicalJson(manifest);
    const now = Date.now();
    const expiresAt = now + REQUEST_TTL_MS;
    const existing = this.db.prepare('SELECT * FROM install_requests WHERE did = ?').get(did) as
      Row | undefined;
    if (existing && existing.manifest === json) {
      this.db
        .prepare('UPDATE install_requests SET expiresAt = ? WHERE did = ?')
        .run(expiresAt, did);
      return toEntry({ ...existing, expiresAt });
    }
    const row: Row = { id: randomUUID(), did, manifest: json, requestedAt: now, expiresAt };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO install_requests (did, id, manifest, requestedAt, expiresAt)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.did, row.id, row.manifest, row.requestedAt, row.expiresAt);
    return toEntry(row);
  }

  get(id: string): InstallRequestEntry | null {
    const row = this.db
      .prepare('SELECT * FROM install_requests WHERE id = ? AND expiresAt >= ?')
      .get(id, Date.now()) as Row | undefined;
    return row ? toEntry(row) : null;
  }

  /** Every live request, oldest first. */
  list(): InstallRequestEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM install_requests WHERE expiresAt >= ? ORDER BY requestedAt, id')
      .all(Date.now()) as Row[];
    return rows.map(toEntry);
  }

  /** The pending request `did` holds, if any. */
  forKey(did: EntityId): InstallRequestEntry | null {
    const row = this.db
      .prepare('SELECT * FROM install_requests WHERE did = ? AND expiresAt >= ?')
      .get(did, Date.now()) as Row | undefined;
    return row ? toEntry(row) : null;
  }

  /**
   * Removes the request `id` names — once it is installed or declined, there
   * is nothing left to ask. A request its key has since replaced has a new
   * id, so removing the old one leaves the new one standing.
   */
  remove(id: string): void {
    this.db.prepare('DELETE FROM install_requests WHERE id = ?').run(id);
  }

  private sweepExpired(): void {
    this.db.prepare('DELETE FROM install_requests WHERE expiresAt < ?').run(Date.now());
  }

  close(): void {
    this.db.close();
  }
}

function toEntry(row: Row): InstallRequestEntry {
  return {
    id: row.id,
    did: row.did,
    manifest: JSON.parse(row.manifest) as AppManifest,
    requestedAt: new Date(row.requestedAt),
    expiresAt: new Date(row.expiresAt),
  };
}

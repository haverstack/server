/**
 * Tracks every open `GET /changes` SSE connection so shutdown can end them
 * up front. `server.close()` (src/shutdown.ts, from #49) waits for open
 * connections to drain on their own before its callback fires — fine for an
 * ordinary request, but a change-feed connection is meant to stay open
 * indefinitely, so left alone it would hold the drain open for the entire
 * shutdown grace period every time. Closing each tracked stream as shutdown
 * begins lets that drain finish immediately instead.
 */
export class ChangeStreamRegistry {
  private readonly streams = new Set<() => void>();

  /** Register an open stream's close callback. Returns the deregister function. */
  add(close: () => void): () => void {
    this.streams.add(close);
    return () => this.streams.delete(close);
  }

  /** Close every currently-open stream. Safe to call with none open. */
  closeAll(): void {
    for (const close of this.streams) close();
  }
}

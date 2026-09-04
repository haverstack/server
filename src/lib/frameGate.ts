/**
 * Bounds a change-feed connection's in-flight frame count. Each accepted
 * send is paired with the write that delivers it; once `maxPending` sends
 * are outstanding at once — a client that isn't draining as fast as
 * changes arrive — the gate reports overflow instead of queuing further
 * sends without bound.
 *
 * Close on overflow, never drop a frame silently: a client that can't tell
 * it missed something can't repair it either, so dropping is worse than
 * disconnecting and letting it reconnect and reconcile.
 */
export class FrameGate {
  private pending = 0;
  private overflowed = false;

  constructor(
    private readonly maxPending: number,
    private readonly onOverflow: () => void,
  ) {}

  /**
   * Accepts one send if there's room, invoking `write` and tracking it
   * until it settles. Returns whether it was accepted; a `false` return
   * means this call (and every one after it) triggered — or already
   * followed — overflow, and `onOverflow` has fired at most once.
   */
  send(write: () => Promise<unknown>): boolean {
    if (this.overflowed) return false;
    if (this.pending >= this.maxPending) {
      this.overflowed = true;
      this.onOverflow();
      return false;
    }
    this.pending++;
    write()
      .catch(() => {})
      .finally(() => {
        this.pending--;
      });
    return true;
  }
}

/**
 * A client-side reader for the change feed's SSE wire format
 * (docs/spec/wire-format.md § Change feed). Hono's own `hono/streaming`
 * ships an SSE *writer* (`streamSSE`) but nothing to consume one — that
 * half is what this module provides, so tests/conformance.test.ts can
 * drive changeFeedFixtures once GET /changes exists (#82): open a
 * connection, decode frames as they arrive, dispatch the fixture's
 * `activity` mutations while it's still open, and collect what the
 * connection produces.
 */
import type { Hono } from 'hono';
import type { AppEnv } from '../src/app.js';

export type DecodedFrame = {
  /**
   * SSE `id:`, when the wire line was present on *this* frame — not the
   * persisted "last event ID" a spec-compliant EventSource client carries
   * forward across events with no id of their own. changeFeedFixtures pins
   * the literal per-frame wire content (a `reset` frame carries no id even
   * immediately after a `record` frame that did), so this decoder resets
   * per frame rather than inheriting.
   */
  id?: string;
  event: string;
  data: unknown;
};

/** Incremental SSE decoder: feed it raw chunks of the stream's text as they arrive. */
export class SSEDecoder {
  private buffer = '';
  private eventName: string | undefined;
  private id: string | undefined;
  private dataLines: string[] = [];
  private sawField = false;

  /** Decode one chunk, returning any frames it completed. */
  push(text: string): DecodedFrame[] {
    this.buffer += text;
    const frames: DecodedFrame[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line === '') {
        const frame = this.dispatch();
        if (frame) frames.push(frame);
        continue;
      }
      if (line.startsWith(':')) continue; // comment line — a keepalive
      const colonIndex = line.indexOf(':');
      const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
      let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      this.sawField = true;
      if (field === 'id') this.id = value;
      else if (field === 'event') this.eventName = value;
      else if (field === 'data') this.dataLines.push(value);
      // 'retry' and any other field: not needed here, ignored.
    }
    return frames;
  }

  private dispatch(): DecodedFrame | undefined {
    if (!this.sawField) return undefined; // a blank line with nothing since the last dispatch
    const event = this.eventName ?? 'message';
    const id = this.id;
    const dataText = this.dataLines.join('\n');
    this.eventName = undefined;
    this.id = undefined;
    this.dataLines = [];
    this.sawField = false;
    let data: unknown = dataText;
    if (dataText) {
      try {
        data = JSON.parse(dataText);
      } catch {
        // Leave as raw text — a fixture asserting on parsed JSON fails loudly.
      }
    }
    return { ...(id !== undefined && { id }), event, data };
  }
}

export type ChangeFeedConnection = {
  status: number;
  /** Frames decoded so far, in arrival order. Mutated in place as more arrive. */
  frames: DecodedFrame[];
  /** Resolves with the first `count` frames once they've arrived, or rejects after timeoutMs. */
  waitForFrames(count: number, timeoutMs?: number): Promise<DecodedFrame[]>;
  /** Cancels the underlying reader and stops decoding. */
  close(): Promise<void>;
};

export type OpenChangeFeedOpts = {
  token?: string;
  /** Additional headers, e.g. Last-Event-ID. */
  headers?: Record<string, string>;
};

/**
 * Opens an SSE connection against a Hono test app. `app.request()` resolves
 * as soon as the response's headers are sent — the body stays open and
 * readable while the server keeps writing — so a mutation dispatched via
 * the ordinary `req()` helper while a connection from this function is
 * still open reaches the same in-process stack and can produce frames on
 * it, exactly as changeFeedFixtures' `activity` expects.
 */
export async function openChangeFeed(
  app: Hono<AppEnv>,
  path: string,
  opts: OpenChangeFeedOpts = {},
): Promise<ChangeFeedConnection> {
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  Object.assign(headers, opts.headers);

  const res = await app.request(path, { headers });
  const reader = res.body?.getReader();
  const decoder = new SSEDecoder();
  const textDecoder = new TextDecoder();
  const frames: DecodedFrame[] = [];
  let closed = false;

  const pump = (async () => {
    if (!reader) return;
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) return;
      frames.push(...decoder.push(textDecoder.decode(value, { stream: true })));
    }
  })();
  // A rejected pump would otherwise surface as an unhandled rejection the
  // moment close() cancels the reader mid-read.
  pump.catch(() => {});

  async function waitForFrames(count: number, timeoutMs = 2000): Promise<DecodedFrame[]> {
    const start = Date.now();
    while (frames.length < count) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for ${count} frame(s); got ${frames.length}: ${JSON.stringify(frames)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return frames.slice(0, count);
  }

  async function close(): Promise<void> {
    closed = true;
    if (reader) await reader.cancel().catch(() => {});
    await pump;
  }

  return { status: res.status, frames, waitForFrames, close };
}

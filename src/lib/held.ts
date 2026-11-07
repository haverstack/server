/**
 * Items that arrive before their consumer can take them, held and then
 * handed over in arrival order. A change feed subscribes before its stream
 * opens, so the changes that arrive first wait here.
 */
export class Held<T> {
  private queue: T[] = [];
  private sink: ((item: T) => boolean) | undefined;

  /** Hands `item` to the consumer if it has opened, or holds it until it does. */
  push(item: T): void {
    if (this.sink) this.sink(item);
    else this.queue.push(item);
  }

  /**
   * Hands over what was held, in order, then each later item as it comes.
   * A `false` from `sink` means the consumer is closing, so the rest of
   * what was held is dropped.
   */
  open(sink: (item: T) => boolean): void {
    const held = this.queue;
    this.queue = [];
    for (const item of held) if (!sink(item)) break;
    this.sink = sink;
  }
}

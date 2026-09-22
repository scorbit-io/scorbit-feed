export type Listener<T> = (value: T) => void;

/**
 * A minimal typed event emitter that works in browsers and Node alike. A
 * listener that throws never interrupts the emitter or the other listeners.
 */
export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  /** Subscribe; returns a function that unsubscribes. */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  protected emit<K extends keyof Events>(event: K, value: Events[K]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      // A listener may have shut the emitter down: the rest of this delivery is dropped.
      if (!this.deliverable()) return;
      try {
        (listener as Listener<Events[K]>)(value);
      } catch (err) {
        this.listenerFailed(event, err);
      }
    }
  }

  /** Whether events may still be delivered. */
  protected deliverable(): boolean {
    return true;
  }

  /** Where a listener's exception goes. By default it is re-thrown outside the emitter. */
  protected listenerFailed(_event: keyof Events, err: unknown): void {
    queueMicrotask(() => {
      throw err;
    });
  }
}

import type { AmeliaEvent } from '../../shared/contracts';

export type EventListener = (event: AmeliaEvent) => void;

export class AmeliaBus {
  private readonly listeners = new Set<EventListener>();

  emit(event: AmeliaEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  createEventStream(signal?: AbortSignal): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let cleanup = () => {};
    return new ReadableStream({
      start: (controller) => {
        const unsubscribe = this.subscribe((event) => {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        });
        const heartbeat = setInterval(() => controller.enqueue(encoder.encode(': heartbeat\n\n')), 15_000);
        cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
        };
        signal?.addEventListener('abort', () => {
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
        }, { once: true });
      },
      cancel: () => cleanup(),
    });
  }
}

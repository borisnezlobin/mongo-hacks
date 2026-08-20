import type { AmeliaEvent } from '../../shared/contracts';

export type EventListener = (event: AmeliaEvent) => void;

export interface SequencedEvent {
  id: number;
  event: AmeliaEvent;
}

/**
 * Events retained for reconnecting clients.
 *
 * A phone that loses wifi mid-conversation reconnects later, and without replay
 * it silently misses everything from the gap — the transcript just has a hole
 * that no amount of reloading explains.
 *
 * Sized against a real recording rather than a guess: a 48-minute conversation
 * between seven people produced roughly 2,800 final utterances plus revisions,
 * so a few events per second while people are actually talking. At 512 this
 * held about four minutes, which is shorter than a phone spends in a pocket.
 * 4,096 covers a realistic backgrounding at a cost of a few megabytes, and a
 * client that falls further behind is genuinely better off refetching the
 * conversation than replaying a long tail — which it is told to do, because
 * a gap is reported rather than papered over.
 */
export const REPLAY_BUFFER_SIZE = 4_096;

/**
 * Events a single slow client may fall behind before we give up on it.
 *
 * The alternative is an unbounded queue, where one backgrounded phone on a bad
 * connection grows the server's heap until it dies. Closing the stream is
 * recoverable: the client reconnects with Last-Event-ID and replays.
 */
const MAX_CLIENT_BACKLOG = 256;

const HEARTBEAT_MS = 15_000;

export class AmeliaBus {
  private readonly listeners = new Set<EventListener>();
  private readonly replayBuffer: SequencedEvent[] = [];
  private nextId = 1;

  /**
   * Fan out to every listener.
   *
   * Each listener is isolated. Previously one throwing listener aborted the
   * whole loop, and because the SSE listeners subscribe first, a single closed
   * browser tab could stop memory extraction, the wake word, and the glasses
   * from ever seeing another event — with no error anywhere that named the
   * cause.
   */
  emit(event: AmeliaEvent): SequencedEvent {
    const sequenced: SequencedEvent = { id: this.nextId++, event };
    this.replayBuffer.push(sequenced);
    if (this.replayBuffer.length > REPLAY_BUFFER_SIZE) this.replayBuffer.shift();

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(`[bus] listener threw on ${event.type}`, error);
      }
    }
    return sequenced;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Everything emitted after `sinceId`, oldest first. */
  replaySince(sinceId: number): SequencedEvent[] {
    return this.replayBuffer.filter((entry) => entry.id > sinceId);
  }

  get lastEventId(): number {
    return this.nextId - 1;
  }

  /**
   * An SSE stream of the bus, resumable via `sinceId` (the client's
   * Last-Event-ID). Every write goes through `send`, which treats a closed
   * controller as a normal end of stream rather than an exception — the old
   * version let a heartbeat fire into a closed controller from a timer
   * callback, where nothing was catching it and it took the process down.
   */
  createEventStream(signal?: AbortSignal, sinceId = 0): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let cleanup = () => {};

    return new ReadableStream({
      start: (controller) => {
        let closed = false;

        const send = (chunk: string): boolean => {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(chunk));
            return true;
          } catch {
            stop();
            return false;
          }
        };

        const stop = () => {
          if (closed) return;
          closed = true;
          cleanup();
          try {
            controller.close();
          } catch {
            /* already closed by the runtime */
          }
        };

        const frame = (entry: SequencedEvent) =>
          `id: ${entry.id}\nevent: ${entry.event.type}\ndata: ${JSON.stringify(entry.event)}\n\n`;

        const pendingReplay = this.replaySince(sinceId);
        // The client asked to resume from an event we have already dropped, so
        // there is a hole we cannot fill. Say so rather than handing back a
        // partial history that looks complete.
        const oldestHeld = this.replayBuffer[0]?.id ?? this.nextId;
        if (sinceId > 0 && oldestHeld > sinceId + 1) {
          console.warn(`[bus] client resumed from ${sinceId} but history starts at ${oldestHeld}`);
          send(': gap\n\n');
        }
        for (const entry of pendingReplay) {
          if (!send(frame(entry))) return;
        }

        let lastDelivered = this.lastEventId;
        const unsubscribe = this.subscribe(() => {
          // Read from the buffer rather than the callback argument so a client
          // that reconnected mid-emit still receives events in sequence order.
          const pending = this.replaySince(lastDelivered);
          if (pending.length > MAX_CLIENT_BACKLOG) {
            console.warn(`[bus] client fell ${pending.length} events behind, closing to force a resync`);
            stop();
            return;
          }
          for (const entry of pending) {
            if (!send(frame(entry))) return;
            lastDelivered = entry.id;
          }
        });

        const heartbeat = setInterval(() => send(': heartbeat\n\n'), HEARTBEAT_MS);
        // Never let the heartbeat alone hold the process open.
        (heartbeat as { unref?: () => void }).unref?.();

        cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
        };

        if (signal?.aborted) stop();
        else signal?.addEventListener('abort', stop, { once: true });
      },
      cancel: () => cleanup(),
    });
  }
}

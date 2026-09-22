import { FeedError } from "./http.js";

/**
 * An incremental Server-Sent Events parser: feed it arbitrary text chunks and
 * it returns the `data` of each complete event. Only `data` matters for
 * Centrifugo's uni_sse, so `event`, `id`, `retry`, comments and unknown fields
 * are dropped as soon as their line is read; they are never retained.
 *
 * Memory is bounded per event, not per chunk, so one chunk may carry any number
 * of complete events. Sizes are in UTF-16 code units (string length):
 * - an event's `data` fields, counted with the newline the join puts between
 *   them, may not pass `maxEvent`, checked before each field is kept;
 * - an event may have at most `maxFields` data fields;
 * - an unterminated line carried to the next chunk is counted exactly as it
 *   would be once complete (a `data:` line by its value, anything else whole),
 *   so a line is accepted or refused the same way however it is split.
 */
/** A `data:` line's value, without the one optional leading space. */
function dataOf(line: string): string {
  const value = line.slice(5);
  return value.startsWith(" ") ? value.slice(1) : value;
}

export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private dataLength = 0;

  /**
   * @param maxEvent The most UTF-16 code units one event's data may take.
   * @param maxFields The most `data` fields one event may have.
   */
  constructor(
    private readonly maxEvent = 1024 * 1024,
    private readonly maxFields = 1024,
  ) {}

  push(chunk: string): string[] {
    const text = this.buffer + chunk;
    const events: string[] = [];
    const newline = /\r\n|\r|\n/g;
    let pos = 0;
    for (;;) {
      newline.lastIndex = pos;
      const match = newline.exec(text);
      if (!match) break;
      // A trailing lone CR may be the first half of a CRLF split across chunks.
      if (match[0] === "\r" && match.index === text.length - 1) break;
      const line = text.slice(pos, match.index);
      pos = match.index + match[0].length;
      if (line === "") {
        if (this.data.length) events.push(this.data.join("\n"));
        this.data = [];
        this.dataLength = 0;
      } else if (line.startsWith("data:")) {
        const data = dataOf(line);
        const cost = this.costOf(data);
        if (this.dataLength + cost > this.maxEvent) throw new FeedError("SSE event too large");
        if (this.data.length >= this.maxFields) {
          throw new FeedError("SSE event has too many data fields");
        }
        this.data.push(data);
        this.dataLength += cost;
      }
    }
    this.buffer = text.slice(pos);
    // A trailing lone CR only waits to see whether an LF follows.
    const pending = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
    const tail = pending.startsWith("data:") ? this.costOf(dataOf(pending)) : pending.length;
    if (this.dataLength + tail > this.maxEvent) throw new FeedError("SSE event too large");
    return events;
  }

  /** What keeping `data` adds: its length, plus the newline the join puts before every field but the first. */
  private costOf(data: string): number {
    return data.length + (this.data.length ? 1 : 0);
  }
}

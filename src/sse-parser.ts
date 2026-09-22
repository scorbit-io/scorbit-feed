import { FeedError } from "./http.js";

/**
 * An incremental Server-Sent Events parser: feed it arbitrary text chunks and
 * it returns the `data` of each complete event. Only `data` matters for
 * Centrifugo's uni_sse, so `event`, `id`, `retry`, comments and unknown fields
 * are dropped as soon as their line is read; they are never retained.
 *
 * Memory is bounded per event: the characters an event would join to
 * (fields plus the newlines between them) and the number of `data` fields are
 * checked before a field is kept, and an unterminated line counts too.
 */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private dataLength = 0;

  /**
   * @param maxEvent The most characters one event may take.
   * @param maxFields The most `data` fields one event may have.
   */
  constructor(
    private readonly maxEvent = 1024 * 1024,
    private readonly maxFields = 1024,
  ) {}

  push(chunk: string): string[] {
    this.buffer += chunk;
    // Checked before any line of the chunk is kept: what a line adds to
    // dataLength (its data plus one newline) never exceeds the line itself, so
    // an event that passes here cannot pass the bound while being parsed.
    if (this.buffer.length + this.dataLength > this.maxEvent) {
      throw new FeedError("SSE event too large");
    }
    const events: string[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // A trailing lone CR may be the first half of a CRLF split across chunks.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (line === "") {
        if (this.data.length) events.push(this.data.join("\n"));
        this.data = [];
        this.dataLength = 0;
      } else if (line.startsWith("data:")) {
        const value = line.slice(5);
        const data = value.startsWith(" ") ? value.slice(1) : value;
        // The join adds a newline before every field but the first.
        const cost = data.length + (this.data.length ? 1 : 0);
        if (this.data.length >= this.maxFields) {
          throw new FeedError("SSE event has too many data fields");
        }
        this.data.push(data);
        this.dataLength += cost;
      }
    }
    return events;
  }
}

import { FeedError } from "./http.js";

/**
 * An incremental Server-Sent Events parser: feed it arbitrary text chunks and
 * it returns the `data` of each complete event. Only `data` matters for
 * Centrifugo's uni_sse, so `event`, `id` and `retry` fields are ignored.
 */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private dataLength = 0;

  /** @param maxEvent The most characters one event may take, so a stream cannot grow memory without bound. */
  constructor(private readonly maxEvent = 1024 * 1024) {}

  push(chunk: string): string[] {
    this.buffer += chunk;
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
        this.data.push(data);
        this.dataLength += data.length;
      }
    }
    return events;
  }
}

/**
 * An incremental Server-Sent Events parser: feed it arbitrary text chunks and
 * it returns the `data` of each complete event. Only `data` matters for
 * Centrifugo's uni_sse, so `event`, `id` and `retry` fields are ignored.
 */
export class SseParser {
  private buffer = "";
  private data: string[] = [];

  push(chunk: string): string[] {
    this.buffer += chunk;
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
      } else if (line.startsWith("data:")) {
        const value = line.slice(5);
        this.data.push(value.startsWith(" ") ? value.slice(1) : value);
      }
    }
    return events;
  }
}

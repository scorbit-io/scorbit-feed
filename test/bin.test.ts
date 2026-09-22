import { afterEach, describe, expect, it, vi } from "vitest";

import type { CliDeps } from "../src/cli.js";

const main = vi.fn<(argv: string[], deps: CliDeps) => Promise<undefined>>(async () => undefined);
vi.mock("../src/cli.js", () => ({ main }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bin entry point", () => {
  it("runs main with the process arguments, environment, signals and a timestamped stderr log", async () => {
    await import("../src/bin.js");
    expect(main).toHaveBeenCalledTimes(1);
    const [argv, deps] = main.mock.calls[0]!;
    expect(argv).toEqual(process.argv.slice(2));
    expect(deps.env).toBe(process.env);
    expect(deps.signals).toBe(process);

    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    deps.log("hello");
    expect(write).toHaveBeenCalledWith(
      expect.stringMatching(/^\[scorbit-feed\] \d{4}-\d\d-\d\dT[^ ]+ hello\n$/),
    );

    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    deps.exit(3);
    expect(exit).toHaveBeenCalledWith(3);
  });
});

/* Every committed or shipped logo carries its copyright and trademark notice. */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const NOTICE =
  "<!-- © 2026 Spinner Systems, Inc. All rights reserved. SCORBIT® and the Scorbit logo are registered trademarks of Spinner Systems, Inc. Not licensed under the MIT license; use only as permitted by https://scorbit.io/developer-terms-of-use/ -->";

const root = new URL("../", import.meta.url);
const svgsIn = (dir: string) =>
  readdirSync(new URL(dir, root))
    .filter((name) => name.endsWith(".svg"))
    .map((name) => `${dir}${name}`);
const SVGS = [...svgsIn("assets/brand/"), ...svgsIn("templates/overlay/")];
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), "utf8");

describe("brand notices", () => {
  it("covers every logo: 11 in assets/brand and the one the overlay ships", () => {
    expect(SVGS.filter((p) => p.startsWith("assets/brand/"))).toHaveLength(11);
    expect(SVGS.filter((p) => p.startsWith("templates/overlay/"))).toEqual([
      "templates/overlay/scorbit_lockup-horizontal_multi.svg",
    ]);
  });

  it.each(SVGS)("%s carries the notice right after the XML declaration", (path) => {
    const [declaration, notice] = read(path).split("\n");
    expect(declaration).toBe('<?xml version="1.0" encoding="UTF-8"?>');
    expect(notice).toBe(NOTICE);
  });

  it.each([
    ["LICENSE", true],
    ["NOTICE", true],
    ["assets/brand/LICENSE", false],
  ])("%s states the owner, the registered trademarks, not MIT, and the terms", (path, numbered) => {
    const text = read(path).replace(/\s+/g, " ");
    const statement = numbered
      ? "SCORBIT® (U.S. Reg. No. 6,705,332) and the Scorbit logo (U.S. Reg. No. 8,291,996) are registered trademarks of Spinner Systems, Inc."
      : /SCORBIT® (\(U\.S\. Reg\. No\. 6,705,332\) )?and the Scorbit logo (\(U\.S\. Reg\. No\. 8,291,996\) )?are registered trademarks of Spinner Systems, Inc\./;
    if (typeof statement === "string") expect(text).toContain(statement);
    else expect(text).toMatch(statement);
    expect(text).toContain("© 2026 Spinner Systems, Inc. All rights reserved.");
    expect(text).toMatch(/not licensed under the MIT license/i);
    expect(text).toContain("no trademark rights are granted");
    expect(text).toContain("https://scorbit.io/developer-terms-of-use/");
  });

  it("keeps the MIT text in LICENSE unchanged below the scope note", () => {
    const license = read("LICENSE");
    expect(license).toMatch(
      /\n---\n\nMIT License\n\nCopyright \(c\) 2026 Spinner Systems, Inc\. \(DBA Scorbit\)\n/,
    );
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  });
});

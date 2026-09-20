/**
 * Rules about the stylesheets that a rendering test would not catch.
 *
 * These read the CSS as text. That sounds crude, and it is exactly right for
 * the thing being checked: a grid floor that cannot collapse is a property of
 * the declaration, not of any one viewport, and testing it by rendering means
 * guessing which widths to try.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(__dirname);
const sheets = readdirSync(DIR)
  .filter((f) => f.endsWith(".css"))
  .map((f) => ({ name: f, css: readFileSync(join(DIR, f), "utf8") }));

describe("grid templates", () => {
  it("has stylesheets to check", () => {
    expect(sheets.length).toBeGreaterThan(0);
  });

  /*
   * A `minmax()` floor is a hard minimum. On a viewport narrower than the
   * floor the track keeps its width and takes the whole document with it, so
   * the page scrolls sideways - which is what `minmax(330px, 1fr)` did at
   * 320px. Wrapping the floor in `min(330px, 100%)` lets it collapse to the
   * container when the container is the smaller of the two.
   *
   * Small floors are fine and common, so this only objects to ones large
   * enough to exceed a phone's content box.
   */
  it("never uses a floor wide enough to outgrow a phone", () => {
    const offenders: string[] = [];

    for (const { name, css } of sheets) {
      for (const decl of css.matchAll(/grid-template-columns:[^;]+;/g)) {
        const text = decl[0];
        for (const floor of text.matchAll(/minmax\(\s*(\d+)px/g)) {
          if (Number(floor[1]) > 200) {
            offenders.push(`${name}: ${text.replace(/\s+/g, " ").trim()}`);
          }
        }
      }
    }

    expect(
      offenders,
      "wrap the floor in min(<px>, 100%) so it can collapse on a narrow screen",
    ).toEqual([]);
  });
});

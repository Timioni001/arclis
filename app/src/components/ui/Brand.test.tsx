/**
 * The mark exists in three places and has to stay one shape.
 *
 * `public/brand/mark.svg` is the asset browsers load, `Brand.tsx` is the one
 * React paints inline, and `scripts/make-icons.py` rasterises the PNGs. Three
 * copies of four numbers is exactly the kind of duplication that drifts
 * quietly: someone nudges the curve in the component, the tab icon keeps the
 * old one, and nobody notices because nobody looks at a 16px favicon twice.
 *
 * Comparing rendered pixels would need a rasteriser. Comparing the geometry
 * is enough, and it is the thing that would actually differ.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..", "..");
const svg = readFileSync(join(root, "public", "brand", "mark.svg"), "utf8");
const component = readFileSync(join(__dirname, "Brand.tsx"), "utf8");
const script = readFileSync(
  join(root, "..", "scripts", "make-icons.py"),
  "utf8",
);

/** Every number in a string, in order. Whitespace and commas both separate. */
function numbers(s: string): number[] {
  return (s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

function arcPath(source: string): number[] {
  const m = source.match(/M7 23\.8C([\d.\s]+)"/);
  if (!m) throw new Error("no arc path found");
  return numbers(`7 23.8 ${m[1]}`);
}

describe("the Arclis mark", () => {
  it("is the same curve in the asset and in the component", () => {
    expect(arcPath(component)).toEqual(arcPath(svg));
  });

  it("is the same curve in the rasteriser", () => {
    const m = script.match(/^ARC = \((.+)\)$/m);
    expect(m, "scripts/make-icons.py must declare ARC").toBeTruthy();
    expect(numbers(m![1])).toEqual(arcPath(svg));
  });

  it("has the same stroke weight everywhere", () => {
    const width = (s: string, re: RegExp) => Number(s.match(re)![1]);
    const asset = width(svg, /stroke-width="([\d.]+)"/);
    expect(width(component, /strokeWidth="([\d.]+)"/)).toBe(asset);
    expect(width(script, /^ARC_WIDTH = ([\d.]+)$/m)).toBe(asset);
  });

  it("puts the leading point in the same place everywhere", () => {
    const dot = (s: string) =>
      numbers(
        s
          .match(/cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/)!
          .slice(1, 4)
          .join(" "),
      );
    expect(dot(component)).toEqual(dot(svg));
    expect(numbers(script.match(/^DOT = \((.+)\)$/m)![1])).toEqual(dot(svg));
  });

  it("uses the same corner radius, so the tile silhouette matches", () => {
    const rx = Number(svg.match(/rx="([\d.]+)"/)![1]);
    expect(Number(component.match(/rx="([\d.]+)"/)![1])).toBe(rx);
    expect(Number(script.match(/^TILE_RADIUS = ([\d.]+)$/m)![1])).toBe(rx);
  });
});

/**
 * The theme's type tokens (`global.css`, docs/app-design.md "Type"): every text size is the
 * design's px, and every line height is the design's px over that size, unitless. A line height in
 * px reads right in a browser but comes out multiplied by the font size on a phone: Tailwind 4
 * sets `line-height: var(--tw-leading, var(--text-<name>--line-height))`, and react-native-css
 * 3.1.0-rc.1 multiplies whatever number that variable holds by the font size
 * (docs/spikes/P0-phone-build.md, section 3).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "global.css"), "utf8");

/** The design's sizes and line heights in px (docs/app-design.md, "Type"). */
const DESIGN: Readonly<Record<string, readonly [size: number, lineHeight: number]>> = {
  state: [44, 48],
  "state-wide": [64, 68],
  title: [32, 40],
  section: [22, 30],
  body: [17, 26],
  small: [15, 22],
};

/** The value `global.css` gives the custom property `name`, or undefined. */
function token(name: string): string | undefined {
  return new RegExp(`^\\s*--${name}:\\s*([^;]+);`, "mu").exec(css)?.[1]?.trim();
}

describe("the type tokens", () => {
  test("the theme has exactly the design's text sizes", () => {
    const names = [...css.matchAll(/^\s*--text-([a-z-]+):\s*\d/gmu)].map((m) => m[1]);
    expect(names.sort()).toEqual(Object.keys(DESIGN).sort());
  });

  for (const [name, [size, lineHeight]] of Object.entries(DESIGN)) {
    test(`${name}: ${String(size)} px on a ${String(lineHeight)} px line, the line height unitless`, () => {
      expect(token(`text-${name}`)).toBe(`${String(size)}px`);
      const ratio = token(`text-${name}--line-height`);
      // Written as the design's two numbers, so a browser computes exactly the px.
      expect(ratio).toBe(`calc(${String(lineHeight)} / ${String(size)})`);
      // No unit anywhere in it: a px or rem there is multiplied by the size on a phone.
      expect(ratio).not.toMatch(/[a-z%]\s*[/)]/u);
      // What the phone's runtime makes of it: the ratio to 4 places (its `calc`), times the size,
      // to 2 places (its `lineHeight`), is the design's px.
      const phone =
        Math.round((Math.round((lineHeight / size) * 10000) / 10000) * size * 100) / 100;
      expect(phone).toBe(lineHeight);
    });
  }
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A `loading.tsx` makes its folder (and every folder under it) stream: the status line goes out before the page runs. A page below
 * it that then calls notFound() or redirect() has already answered 200, so a tampered booking link or a payment that does not exist
 * would look like a success to anything checking the status. See components/ui/page-loading.tsx. This keeps loading files off any
 * folder that has such a page at or below it.
 */
const APP = join(process.cwd(), "app");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(APP);
const loadingDirs = files.filter((f) => f.endsWith("/loading.tsx")).map((f) => f.slice(0, -"/loading.tsx".length));

/** The files that run inside a loading boundary on `dir`: its page, and the pages and layouts of every folder below it. */
function insideBoundary(dir: string): string[] {
  return files.filter((f) => {
    if (!f.startsWith(`${dir}/`)) return false;
    const rest = f.slice(dir.length + 1);
    if (rest === "page.tsx") return true;
    return /(^|\/)(page|layout)\.tsx$/.test(rest) && rest.includes("/");
  });
}

describe("loading boundaries", () => {
  it("finds the loading files it is meant to guard", () => {
    expect(loadingDirs.length).toBeGreaterThan(0);
  });
  it.each(loadingDirs.map((d) => [relative(APP, d) || "/", d]))(
    "%s has no page that can be not-found or redirect beneath it",
    (_name, dir) => {
      const offenders = insideBoundary(dir as string).filter((f) =>
        /\b(notFound|redirect|permanentRedirect)\(/.test(readFileSync(f, "utf8")),
      );
      expect(offenders.map((f) => relative(APP, f))).toEqual([]);
    },
  );
});

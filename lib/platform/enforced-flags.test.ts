import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_OFF_FLAGS } from "./hotel";

/**
 * The list of enforced plan flags is written in SQL (`plan_enforced_flags()`, redefined by each migration that adds a flag) and
 * repeated by hand on the plans page. They drifted once (`ai_helpers` was in SQL and missing on the page). These tests read the
 * newest SQL definition and the page and fail when they disagree, so adding a flag in one place and not the other is caught.
 */
const root = path.resolve(__dirname, "../..");
const migrations = path.join(root, "supabase/migrations");

function latestEnforcedFlags(): { file: string; keys: string[] } {
  const files = readdirSync(migrations)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files.reverse()) {
    const sql = readFileSync(path.join(migrations, file), "utf8");
    const at = sql.search(/create (or replace )?function plan_enforced_flags\(\)/i);
    if (at < 0) continue;
    const body = /select array\[([\s\S]*?)\]/i.exec(sql.slice(at));
    if (!body?.[1]) continue;
    return { file, keys: [...body[1].matchAll(/'([a-z_.]+)'/g)].map((m) => m[1] as string) };
  }
  throw new Error("no plan_enforced_flags() definition found in the migrations");
}

function plansPageFlags(): string[] {
  const page = readFileSync(path.join(root, "app/platform/plans/page.tsx"), "utf8");
  const list = /const ENFORCED = \[([\s\S]*?)\];/.exec(page);
  if (!list?.[1]) throw new Error("ENFORCED list not found on the plans page");
  return [...list[1].matchAll(/"([a-z_.]+)"/g)].map((m) => m[1] as string);
}

describe("enforced plan flags", () => {
  const sql = latestEnforcedFlags();
  it("are the same on the plans page as in the newest plan_enforced_flags()", () => {
    expect([...plansPageFlags()].sort(), `newest definition: ${sql.file}`).toEqual([...sql.keys].sort());
  });
  it("have no flag listed twice", () => {
    expect(new Set(sql.keys).size).toBe(sql.keys.length);
  });
  it("include every opt-in flag, so the grid can say it is off by default", () => {
    for (const key of DEFAULT_OFF_FLAGS) expect(sql.keys).toContain(key);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The audit address (migration 170) travels as one header from the app to the database trigger. These read the source so the two
// ends cannot drift apart, and so the address is never sent from a place that should not send it.
describe("the audit address header", () => {
  const server = readFileSync("lib/supabase/server.ts", "utf8");
  const migration = readFileSync("supabase/migrations/20261026000170_audit_client_ip.sql", "utf8");

  it("is the same name in the staff server client and in the trigger", () => {
    expect(server).toContain('"x-client-ip"');
    expect(migration).toContain("->> 'x-client-ip'");
  });

  it("is sent only when the address is known", () => {
    expect(server).toMatch(/ip === "unknown" \? \{\} : \{ "x-client-ip": ip \}/);
  });

  it("is taken from the platform's forwarded address, never from a header the visitor could name for themselves", () => {
    expect(server).toContain("clientIp(await headers())");
    expect(server).not.toMatch(/headers\(\)\)?\.get\(["']x-client-ip["']\)/);
  });

  it("is not sent by the service client the guest site and webhooks use, so guests are never recorded", () => {
    expect(readFileSync("lib/supabase/service.ts", "utf8")).not.toContain("x-client-ip");
  });

  it("does not reach the platform audit list, which never showed hotel staff details", () => {
    expect(readFileSync("lib/platform/audit.ts", "utf8")).not.toContain("client_ip");
    const list = readFileSync("supabase/migrations/20261026000126_platform_audit_log.sql", "utf8");
    expect(list).not.toContain("client_ip");
  });

  it("never lets a bad header stop an audit row: the trigger swallows its own errors and takes only a host address", () => {
    expect(migration).toMatch(/exception when others then/);
    expect(migration).toContain("masklen(v_ip)");
    expect(migration).toMatch(/before insert on audit_logs/);
  });
});

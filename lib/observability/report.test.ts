import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportError } from "./report";
import { errorReference } from "./ui-text";

afterEach(() => vi.unstubAllGlobals());
const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("reportError", () => {
  it("does nothing, and does not call the network, without a DSN or with a bad one", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await reportError(new Error("a"), {}, env({}))).toBe(false);
    expect(await reportError(new Error("a"), {}, env({ ERROR_REPORT_DSN: "nonsense" }))).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
  it("posts an envelope with the key header when a DSN is set", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", f);
    const sent = await reportError(new Error("unique-one"), { routePath: "/app/x" }, env({ ERROR_REPORT_DSN: "https://k1@t.example/5", ERROR_REPORT_ENV: "staging" }));
    expect(sent).toBe(true);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://t.example/api/5/envelope/");
    expect(init.headers["X-Sentry-Auth"]).toContain("sentry_key=k1");
    expect(init.body).toContain('"environment":"staging"');
  });
  it("reports the same error once, and never throws when the tracker is down", async () => {
    const f = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", f);
    const e = env({ ERROR_REPORT_DSN: "https://k@t.example/5" });
    const same = new Error("down-case");
    expect(await reportError(same, {}, e)).toBe(false);
    expect(await reportError(same, {}, e)).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("error pages", () => {
  it("shows only a plain reference, never the error text", () => {
    expect(errorReference("1234567890")).toBe("1234567890");
    for (const v of [undefined, "", "a", "has space", "<script>", "x".repeat(41)]) expect(errorReference(v)).toBeNull();
    for (const f of ["app/error.tsx", "app/global-error.tsx"]) expect(readFileSync(f, "utf8")).not.toMatch(/error\.message|error\.stack/);
  });
  it("wires the server hook to the reporter", () => {
    expect(readFileSync("instrumentation.ts", "utf8")).toMatch(/export const onRequestError/);
  });
});

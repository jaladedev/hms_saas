import { describe, expect, it } from "vitest";
import { parseContactForm } from "./contact";

const good = { name: "Ada Guest", email: "Ada@Example.com", message: "Do you have parking?" };

describe("parseContactForm", () => {
  it("accepts a normal message and lowercases the email", () => {
    const r = parseContactForm(good);
    expect(r).toEqual({ ok: true, value: { name: "Ada Guest", email: "ada@example.com", message: "Do you have parking?" } });
  });
  it("keeps line breaks but squeezes blank runs and trims", () => {
    const r = parseContactForm({ ...good, message: "  Hello\r\n\r\n\r\n\r\nSecond line \n" });
    expect(r.ok && r.value.message).toBe("Hello\n\nSecond line");
  });
  it("refuses a bad email, a short name and a short or long message", () => {
    expect(parseContactForm({ ...good, email: "nope" }).ok).toBe(false);
    expect(parseContactForm({ ...good, name: "A" }).ok).toBe(false);
    expect(parseContactForm({ ...good, message: "Hi" }).ok).toBe(false);
    expect(parseContactForm({ ...good, message: "x".repeat(2001) }).ok).toBe(false);
    expect(parseContactForm({ ...good, message: "x".repeat(2000) }).ok).toBe(true);
  });
  it("refuses missing or non-text fields", () => {
    expect(parseContactForm({}).ok).toBe(false);
    expect(parseContactForm({ ...good, message: 5 }).ok).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import { drainPhotoCleanup } from "./photo-cleanup";

describe("drainPhotoCleanup", () => {
  it("does nothing when nothing is queued", async () => {
    const remove = vi.fn(),
      finish = vi.fn();
    expect(await drainPhotoCleanup({ claim: async () => [], remove, finish })).toEqual({ claimed: 0, cleared: 0, error: null });
    expect(remove).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });
  it("removes the claimed files and then clears exactly those paths", async () => {
    const remove = vi.fn(async () => ({ error: null })),
      finish = vi.fn(async (p: string[]) => p.length);
    const out = await drainPhotoCleanup({
      claim: async (l) => {
        expect(l).toBe(50);
        return ["a.jpg", "b.png"];
      },
      remove,
      finish,
    });
    expect(remove).toHaveBeenCalledWith(["a.jpg", "b.png"]);
    expect(finish).toHaveBeenCalledWith(["a.jpg", "b.png"]);
    expect(out).toEqual({ claimed: 2, cleared: 2, error: null });
  });
  it("leaves the paths queued when the file store refuses", async () => {
    const finish = vi.fn();
    const out = await drainPhotoCleanup({ claim: async () => ["a.jpg"], remove: async () => ({ error: "storage down" }), finish });
    expect(finish).not.toHaveBeenCalled();
    expect(out).toEqual({ claimed: 1, cleared: 0, error: "storage down" });
  });
});

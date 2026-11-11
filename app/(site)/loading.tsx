import { Bone } from "@/components/ui/skeleton";

// Shown under the guest header while a page loads.
export default function Loading() {
  return (
    <div role="status" aria-busy="true" className="mx-auto max-w-6xl px-4 py-10">
      <span className="sr-only">Loading…</span>
      <Bone className="h-10 w-72 max-w-full" />
      <Bone className="mt-3 h-4 w-96 max-w-full" />
      <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="overflow-hidden rounded-2xl border border-line bg-white">
            <Bone className="aspect-[4/3] w-full !rounded-none" />
            <div className="space-y-2 p-4">
              <Bone className="h-5 w-2/3" />
              <Bone className="h-4 w-full" />
              <Bone className="h-4 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

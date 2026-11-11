// Live check of the one Paystack call the bank-details retry form depends on: GET /bank (read only, moves no money).
// The app (lib/paystack.ts listBanks) was written from Paystack's docs; this confirms the real response matches what it expects.
//
//   PAYSTACK_SECRET_KEY=sk_test_... npm run paystack:check
//
// Refuses a live key (sk_live_), so it can only ever run against TEST mode. Prints no secret.
// Not covered here: POST /refund/retry_with_customer_details/:id. Paystack only accepts it for a refund it has just reported as
// needs-attention, which cannot be forced on demand; see TODO.md.

const key = process.env.PAYSTACK_SECRET_KEY ?? "";
const base = process.env.PAYSTACK_API_BASE_URL ?? "https://api.paystack.co";
if (!key.startsWith("sk_test_")) {
  console.error("Set PAYSTACK_SECRET_KEY to a TEST secret key (sk_test_...). Live keys are refused on purpose.");
  process.exit(2);
}

const problems = [];
const note = (ok, text) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${text}`);
  if (!ok) problems.push(text);
};

const banks = [];
const queries = [];
let cursor = null;
let pages = 0;
for (; pages < 10; ) {
  const params = new URLSearchParams({ currency: "NGN", perPage: "100", use_cursor: "true", country: "nigeria" });
  if (cursor) params.set("next", cursor);
  queries.push(params.toString());
  let res;
  try {
    res = await fetch(`${base}/bank?${params}`, { headers: { Authorization: `Bearer ${key}` } });
  } catch {
    console.error(`Could not reach ${base}. Run this from a computer with internet access.`);
    process.exit(3);
  }
  pages += 1;
  note(res.ok, `page ${pages}: HTTP ${res.status}`);
  if (!res.ok) break;
  const body = await res.json();
  note(body.status === true, `page ${pages}: status is true`);
  note(Array.isArray(body.data), `page ${pages}: data is an array (${body.data?.length ?? 0} banks)`);
  if (!Array.isArray(body.data)) break;
  banks.push(...body.data);
  cursor = body.meta?.next ?? null;
  note(
    cursor === null || typeof cursor === "string",
    `page ${pages}: meta.next is a string or null (${cursor === null ? "last page" : "more pages"})`,
  );
  if (!cursor) break;
}

if (banks.length) {
  const idTypes = [...new Set(banks.map((b) => typeof b.id))];
  note(
    banks.every((b) => b.id !== undefined && b.id !== null && String(b.id).length > 0),
    `every bank has an id (types seen: ${idTypes.join(", ")})`,
  );
  note(
    banks.every((b) => typeof b.name === "string" && b.name.length > 0),
    "every bank has a name",
  );
  note(new Set(banks.map((b) => String(b.id))).size === banks.length, "ids are unique, so they can be the form's option values");
  note(
    banks.every((b) => b.currency === "NGN"),
    "every bank is in NGN",
  );
  const sample = banks.slice(0, 3).map((b) => `${b.id} ${b.name}`);
  console.log(`sample: ${sample.join(" | ")}`);
  console.log(`first page request: ${queries[0]}`);
}

console.log(
  problems.length
    ? `\n${problems.length} check(s) failed. Fix lib/paystack.ts listBanks and the fake in e2e/fake-paystack.mjs to match.`
    : "\nThe bank list matches what the app expects. Next: tick the bank-list part of the TODO item; the retry itself still needs a real needs-attention refund.",
);
process.exit(problems.length ? 1 : 0);

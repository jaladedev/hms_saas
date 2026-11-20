import { buttonPrimary, buttonQuiet, ErrorBanner, inputClass, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { createClient } from "@/lib/supabase/server";
import { issueVoucher, voidVoucher } from "@/lib/staff/vouchers-actions";
import { parseVoucherList, STATUS_LABEL, VOUCHER_KINDS } from "@/lib/staff/vouchers";

export const dynamic = "force-dynamic";

/**
 * Gift and discount vouchers (migration 161). People with property.configure issue and void them; staff with discount.apply spend a
 * voucher from the booking page. Issuing does not record a payment: a sold gift voucher is money the hotel takes in its own books. The
 * database decides on every action, so a person without the right sees a refusal.
 */
export default async function VouchersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const rawCode = typeof search.vc === "string" ? search.vc : "";
  const newCode = /^[A-Z0-9-]{6,24}$/.test(rawCode) ? rawCode : null;

  const supabase = await createClient();
  const { data: props, error: propError } = await supabase.from("properties").select("id, name, currency").order("name");
  const properties = (props ?? []) as { id: string; name: string; currency: string }[];
  const results = await Promise.all(
    properties.map(async (p) => ({ list: await supabase.rpc("voucher_list", { p_property: p.id, p_limit: 200 }) })),
  );
  // A hotel the person may not configure answers NOT_FOUND and is left out; any other failure is shown.
  const failed = Boolean(propError) || results.some((r) => r.list.error && !/NOT_FOUND/.test(r.list.error.message));
  const many = properties.length > 1;

  return (
    <main className="max-w-5xl">
      <PageTitle>Vouchers</PageTitle>
      <PageIntro>
        A gift voucher holds a value that can be spent on one or more bookings. A discount voucher takes its value off one booking and is
        then used up. Staff enter the code on the booking page; it becomes that booking&rsquo;s one discount and is taken off the room price
        plus tax. A voucher is valid at the hotel that issued it. Issuing a voucher does not record a payment: if you sell it, record the
        money in your own books.
      </PageIntro>
      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>
      {newCode && (
        <p role="status" className="mb-5 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm">
          New voucher code: <strong className="font-mono text-base tracking-wide">{newCode}</strong>
        </p>
      )}
      {failed && <ErrorBanner className="mb-6">Vouchers could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p, i) => {
        const r = results[i];
        if (!r || (r.list.error && /NOT_FOUND/.test(r.list.error.message))) return null;
        const vouchers = parseVoucherList(r.list.data);
        const money = (m: number) => formatMoney(m, p.currency);
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}

            <div className="mt-4 rounded border border-dashed border-line bg-white p-4">
              <h3 className="text-sm font-medium">Issue a voucher</h3>
              <form action={issueVoucher} className="mt-3 grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="propertyId" value={p.id} />
                <input type="hidden" name="key" value={crypto.randomUUID()} />
                <label className="block text-sm" htmlFor={`k-${p.id}`}>
                  Kind
                  <select id={`k-${p.id}`} name="kind" defaultValue="gift" className={`${inputClass} mt-1`}>
                    {VOUCHER_KINDS.map((k) => (
                      <option key={k.kind} value={k.kind}>
                        {k.label}: {k.help}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm" htmlFor={`a-${p.id}`}>
                  Value (naira, 100 to 1,000,000)
                  <input id={`a-${p.id}`} name="amount" required inputMode="decimal" placeholder="50000" className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-sm" htmlFor={`e-${p.id}`}>
                  Expires on (optional)
                  <input id={`e-${p.id}`} name="expiresOn" type="date" className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-sm" htmlFor={`n-${p.id}`}>
                  Note (optional, for your own records)
                  <input id={`n-${p.id}`} name="note" maxLength={200} placeholder="Bought by Mr Bello" className={`${inputClass} mt-1`} />
                </label>
                <div className="sm:col-span-2">
                  <PendingButton className={buttonPrimary} pendingLabel="Issuing…">
                    Issue voucher
                  </PendingButton>
                </div>
              </form>
            </div>

            <div className="mt-8">
              <h3 className="font-display text-xl">Issued vouchers</h3>
              {vouchers.length === 0 ? (
                <p className="mt-3 text-sm text-muted">No vouchers yet.</p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Vouchers issued by {p.name}</caption>
                    <thead>
                      <tr className="border-b border-line text-left">
                        <th scope="col" className="py-2 pr-3 font-medium">
                          Code
                        </th>
                        <th scope="col" className="py-2 pr-3 font-medium">
                          Kind
                        </th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">
                          Value
                        </th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">
                          Left
                        </th>
                        <th scope="col" className="py-2 pr-3 font-medium">
                          Status
                        </th>
                        <th scope="col" className="py-2 pr-3 font-medium">
                          Expires
                        </th>
                        <th scope="col" className="py-2 font-medium">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {vouchers.map((v) => (
                        <tr key={v.id} className="border-b border-line align-top">
                          <th scope="row" className="py-2 pr-3 text-left font-mono font-normal">
                            {v.code}
                            {v.note && <span className="block font-sans text-xs text-muted">{v.note}</span>}
                          </th>
                          <td className="py-2 pr-3">{v.kind === "gift" ? "Gift" : "Discount"}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{money(v.face_value_minor)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{money(v.balance_minor)}</td>
                          <td className="py-2 pr-3">{STATUS_LABEL[v.status]}</td>
                          <td className="py-2 pr-3">{v.expires_on ? formatDate(v.expires_on) : "None"}</td>
                          <td className="py-2">
                            {(v.status === "active" || v.status === "expired") && (
                              <details>
                                <summary className="cursor-pointer text-primary-strong">Void</summary>
                                <form action={voidVoucher} className="mt-2 grid gap-2">
                                  <input type="hidden" name="voucherId" value={v.id} />
                                  <label className="block text-xs" htmlFor={`vr-${v.id}`}>
                                    Reason
                                    <input id={`vr-${v.id}`} name="reason" required maxLength={200} className={`${inputClass} mt-1`} />
                                  </label>
                                  <PendingButton className={buttonQuiet} pendingLabel="Voiding…">
                                    Void and write off {money(v.balance_minor)}
                                  </PendingButton>
                                </form>
                              </details>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        );
      })}
    </main>
  );
}

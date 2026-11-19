import { buttonQuiet, ErrorBanner, inputClass, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { saveSmsSettings } from "@/lib/staff/sms-actions";
import {
  kindLabel,
  MAX_SMS_CAP,
  parseFailures,
  parseUsage,
  SMS_KIND_CHOICES,
  SMS_REMINDER_DAYS,
  smsSummary,
} from "@/lib/staff/sms-settings";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Property = {
  id: string;
  name: string;
  sms_enabled: boolean;
  sms_kinds: string[];
  sms_channel: string;
  sms_monthly_cap: number;
  sms_reminder_days: number;
};

/**
 * Text messages to guests (migration 147): booking confirmed, arrival reminder, review request. Off until switched on here, and
 * only when the hotel group's plan includes it. Only people who may change the hotel setup (property.configure) see a hotel here;
 * the database decides on every save.
 */
export default async function MessagesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const propQ = await supabase
    .from("properties")
    .select("id, name, sms_enabled, sms_kinds, sms_channel, sms_monthly_cap, sms_reminder_days")
    .order("name");
  const properties = (propQ.data ?? []) as Property[];
  const results = await Promise.all(
    properties.map(async (p) => ({
      usage: await supabase.rpc("sms_usage", { p_property: p.id }),
      failures: await supabase.rpc("sms_recent_failures", { p_property: p.id }),
    })),
  );
  const failed =
    Boolean(propQ.error) || results.some((r) => [r.usage, r.failures].some((x) => x.error && !/NOT_FOUND/.test(x.error.message)));
  const many = properties.length > 1;
  let shown = 0;

  return (
    <main className="max-w-3xl">
      <PageTitle>Text messages</PageTitle>
      <PageIntro>
        Short texts to guests who gave a mobile number when they booked on your website. A text never contains the private booking link: it
        has the booking reference and a link to your site&rsquo;s booking lookup, where a fresh link is emailed to the address on the
        booking. Guests can switch texts off from their booking page, and you can switch them off for a guest from their profile.
      </PageIntro>
      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>
      {failed && <ErrorBanner className="mb-6">Text message settings could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p, i) => {
        const r = results[i];
        if (!r || (r.usage.error && /NOT_FOUND/.test(r.usage.error.message))) return null;
        shown++;
        const usage = parseUsage(r.usage.data);
        const failures = parseFailures(r.failures.data);
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}
            {!usage.plan_enabled && (
              <ErrorBanner className="mt-4">
                Text messages are not included in your hotel group&rsquo;s plan, so none are sent. Contact the platform to add them.
              </ErrorBanner>
            )}
            <form action={saveSmsSettings} className="mt-4 rounded border border-line bg-white p-4">
              <input type="hidden" name="propertyId" value={p.id} />
              <fieldset disabled={!usage.plan_enabled} className="border-0 p-0">
                <p className="text-sm text-muted">{smsSummary(p.sms_enabled, p.sms_kinds, p.sms_monthly_cap)}</p>
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input type="checkbox" name="enabled" defaultChecked={p.sms_enabled} />
                  Send text messages to guests
                </label>
                <fieldset className="mt-4">
                  <legend className="text-sm font-medium">Which messages</legend>
                  {SMS_KIND_CHOICES.map((k) => (
                    <label key={k.key} className="mt-2 flex items-start gap-2 text-sm">
                      <input type="checkbox" name="kind" value={k.key} defaultChecked={p.sms_kinds.includes(k.key)} className="mt-1" />
                      <span>
                        {k.label}
                        <span className="block text-xs text-muted">{k.help}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  <div>
                    <label htmlFor={`sc-${p.id}`} className="block text-sm">
                      Send through
                    </label>
                    <select id={`sc-${p.id}`} name="channel" defaultValue={p.sms_channel} className={inputClass}>
                      <option value="sms">SMS</option>
                      <option value="whatsapp">WhatsApp</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`sd-${p.id}`} className="block text-sm">
                      Remind guests
                    </label>
                    <select id={`sd-${p.id}`} name="reminderDays" defaultValue={String(p.sms_reminder_days)} className={inputClass}>
                      {SMS_REMINDER_DAYS.map((d) => (
                        <option key={d} value={d}>
                          {d === 1 ? "the day before" : `up to ${d} days before`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`sm-${p.id}`} className="block text-sm">
                      Most texts a month
                    </label>
                    <input
                      id={`sm-${p.id}`}
                      name="monthlyCap"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={MAX_SMS_CAP}
                      step={1}
                      defaultValue={p.sms_monthly_cap}
                      className={inputClass}
                    />
                  </div>
                </div>
                <p className="mt-3 text-xs text-muted">
                  WhatsApp only works if your messaging provider account is set up for it; a text that cannot be delivered is listed below
                  as failed. The monthly limit is a safety net, counted in your hotel&rsquo;s own time zone; set 0 to stop all texts. It can
                  end a few texts over when several are queued in the same moment.
                </p>
                <div className="mt-4">
                  <PendingButton className={buttonQuiet}>Save</PendingButton>
                </div>
              </fieldset>
            </form>

            <h3 className="mt-6 font-display text-xl">This month</h3>
            <p className="mt-1 text-sm">
              {usage.used_this_month.toLocaleString("en-GB")} of {usage.cap.toLocaleString("en-GB")} texts used.
            </p>
            {usage.months.length > 0 && (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Texts by month</caption>
                  <thead>
                    <tr className="border-b border-line text-left">
                      <th scope="col" className="py-2 pr-3 font-medium">
                        Month
                      </th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">
                        Sent
                      </th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">
                        Waiting
                      </th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">
                        Failed
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.months.map((m) => (
                      <tr key={m.month} className="border-b border-line">
                        <th scope="row" className="py-2 pr-3 text-left font-normal">
                          {m.month}
                        </th>
                        <td className="py-2 pr-3 text-right">{m.sent}</td>
                        <td className="py-2 pr-3 text-right">{m.waiting}</td>
                        <td className="py-2 pr-3 text-right">{m.failed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h3 className="mt-6 font-display text-xl">Recent failures</h3>
            {failures.length === 0 ? (
              <p className="mt-1 text-sm text-muted">No failed texts.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line rounded border border-line bg-white text-sm">
                {failures.map((f) => (
                  <li key={f.id} className="p-3">
                    <span className="font-medium">{kindLabel(f.kind)}</span> to {f.to}, after {f.attempts}{" "}
                    {f.attempts === 1 ? "try" : "tries"}
                    <span className="block text-xs text-muted">{f.error ?? "No reason given"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {shown === 0 && !failed && (
        <p className="mt-6 text-sm text-muted">Only people who may change the hotel setup can see the text message settings.</p>
      )}
    </main>
  );
}

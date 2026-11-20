import { ErrorBanner } from "@/components/staff/ui";
import { GROUP_ERROR_MESSAGES, GROUP_OK_MESSAGES, type GroupErrorCode, type GroupOkCode } from "@/lib/staff/groups";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Result of the last group action, read from ?group= / ?grouperr=. Both are short codes, never free text. */
export function GroupNotice({ search }: { search: Record<string, string | string[] | undefined> }) {
  const err = one(search.grouperr);
  const ok = one(search.group);
  if (err && err in GROUP_ERROR_MESSAGES) return <ErrorBanner className="mb-5">{GROUP_ERROR_MESSAGES[err as GroupErrorCode]}</ErrorBanner>;
  if (ok && ok in GROUP_OK_MESSAGES)
    return (
      <p role="status" className="mb-5 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-primary-strong">
        {GROUP_OK_MESSAGES[ok as GroupOkCode]}
        {ok === "group_rate_applied" && /^\d{1,3}$/.test(one(search.applied) ?? "") && /^\d{1,3}$/.test(one(search.skipped) ?? "")
          ? ` Applied to ${one(search.applied)} booking(s); ${one(search.skipped)} skipped (not confirmed, already discounted, or has a payment or invoice).`
          : ""}
      </p>
    );
  return null;
}

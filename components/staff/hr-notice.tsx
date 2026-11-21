import { ErrorBanner } from "@/components/staff/ui";
import { HR_ERROR_MESSAGES, HR_OK_MESSAGES, type HrErrorCode, type HrOkCode } from "@/lib/staff/hr";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Result of the last shifts action, read from ?hr= / ?hrerr=. Both are short codes, never free text. */
export function HrNotice({ search }: { search: Record<string, string | string[] | undefined> }) {
  const err = one(search.hrerr);
  const ok = one(search.hr);
  if (err && err in HR_ERROR_MESSAGES) return <ErrorBanner className="mb-5">{HR_ERROR_MESSAGES[err as HrErrorCode]}</ErrorBanner>;
  if (ok && ok in HR_OK_MESSAGES)
    return (
      <p role="status" className="mb-5 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-primary-strong">
        {HR_OK_MESSAGES[ok as HrOkCode]}
      </p>
    );
  return null;
}

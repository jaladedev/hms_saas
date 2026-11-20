import { ErrorBanner } from "@/components/staff/ui";
import { SVC_ERROR_MESSAGES, SVC_OK_MESSAGES, type SvcErrorCode, type SvcOkCode } from "@/lib/staff/services";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Result of the last services action, read from ?svc= / ?svcerr=. Both are short codes, never free text. */
export function ServicesNotice({ search }: { search: Record<string, string | string[] | undefined> }) {
  const err = one(search.svcerr);
  const ok = one(search.svc);
  if (err && err in SVC_ERROR_MESSAGES) return <ErrorBanner className="mb-5">{SVC_ERROR_MESSAGES[err as SvcErrorCode]}</ErrorBanner>;
  if (ok && ok in SVC_OK_MESSAGES)
    return (
      <p role="status" className="mb-5 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-primary-strong">
        {SVC_OK_MESSAGES[ok as SvcOkCode]}
      </p>
    );
  return null;
}

import { ErrorBanner } from "@/components/staff/ui";
import { POS_ERROR_MESSAGES, POS_OK_MESSAGES, type PosErrorCode, type PosOkCode } from "@/lib/staff/pos";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Result of the last restaurant and bar action, read from ?pos= / ?poserr=. Both are short codes, never free text. */
export function PosNotice({ search }: { search: Record<string, string | string[] | undefined> }) {
  const err = one(search.poserr);
  const ok = one(search.pos);
  if (err && err in POS_ERROR_MESSAGES) return <ErrorBanner className="mb-5">{POS_ERROR_MESSAGES[err as PosErrorCode]}</ErrorBanner>;
  if (ok && ok in POS_OK_MESSAGES)
    return (
      <p role="status" className="mb-5 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-primary-strong">
        {POS_OK_MESSAGES[ok as PosOkCode]}
      </p>
    );
  return null;
}

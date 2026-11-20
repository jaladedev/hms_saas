import { ErrorBanner } from "@/components/staff/ui";
import { INV_ERROR_MESSAGES, INV_OK_MESSAGES, type InvErrorCode, type InvOkCode } from "@/lib/staff/inventory";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Result of the last stock action, read from ?inv= / ?inverr=. Both are short codes, never free text. */
export function InventoryNotice({ search }: { search: Record<string, string | string[] | undefined> }) {
  const err = one(search.inverr);
  const ok = one(search.inv);
  if (err && err in INV_ERROR_MESSAGES) return <ErrorBanner className="mb-5">{INV_ERROR_MESSAGES[err as InvErrorCode]}</ErrorBanner>;
  if (ok && ok in INV_OK_MESSAGES)
    return (
      <p role="status" className="mb-5 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-primary-strong">
        {INV_OK_MESSAGES[ok as InvOkCode]}
      </p>
    );
  return null;
}

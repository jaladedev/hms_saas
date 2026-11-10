import { ErrorBanner } from "@/components/staff/ui";
import { ERROR_MESSAGES, FIELD_MESSAGES, isPlatformCode, isPlatformOk, OK_MESSAGES, type NewHotelField } from "@/lib/platform/hotel";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Result of the last platform action, read from ?ok= / ?err= (short codes only, never free text). */
export function PlatformNotice({ search }: { search: Search }) {
  const err = one(search.err);
  const ok = one(search.ok);
  if (err) {
    const field = one(search.field);
    const text =
      field && field in FIELD_MESSAGES && err === "bad_request"
        ? FIELD_MESSAGES[field as NewHotelField]
        : isPlatformCode(err)
          ? ERROR_MESSAGES[err]
          : ERROR_MESSAGES.bad_request;
    return <ErrorBanner className="mb-5">{text}</ErrorBanner>;
  }
  if (isPlatformOk(ok))
    return (
      <p role="status" className="mb-5 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-primary-strong">
        {OK_MESSAGES[ok]}
      </p>
    );
  return null;
}

import { ErrorBanner } from "@/components/staff/ui";
import { CHANNEL_ERROR_MESSAGES, CHANNEL_OK_MESSAGES, type ChannelErrorCode, type ChannelOkCode } from "@/lib/staff/channel-sync";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Result of the last channels action, read from ?ch= / ?cherr=. Both are short codes, never free text. */
export function ChannelsNotice({ search }: { search: Record<string, string | string[] | undefined> }) {
  const err = one(search.cherr);
  const ok = one(search.ch);
  if (err && err in CHANNEL_ERROR_MESSAGES)
    return <ErrorBanner className="mb-5">{CHANNEL_ERROR_MESSAGES[err as ChannelErrorCode]}</ErrorBanner>;
  if (ok && ok in CHANNEL_OK_MESSAGES)
    return (
      <p role="status" className="mb-5 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-primary-strong">
        {CHANNEL_OK_MESSAGES[ok as ChannelOkCode]}
      </p>
    );
  return null;
}

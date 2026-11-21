import Link from "next/link";
import { ChannelCreateGate } from "./gate";
import { ChannelsNotice } from "@/components/staff/channels-notice";
import {
  buttonPrimary,
  buttonQuiet,
  cardClass,
  EmptyState,
  ErrorBanner,
  inputClass,
  PageIntro,
  PageTitle,
  SectionTitle,
} from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatMoney } from "@/lib/guest-site/format";
import { formatDateTime } from "@/lib/staff/format";
import {
  BOOKING_STATUS_LABEL,
  CHANNEL_LABEL,
  COLLECTS_LABEL,
  failureWords,
  parseBookings,
  parseChannelReport,
  parseConnections,
  parseMap,
  type BookingStatus,
} from "@/lib/staff/channel-sync";
import { loadChannelsContext } from "@/lib/staff/channel-sync-access";
import { removeMapping, resolveBooking, retryBooking, saveMapping, setConnectionStatus } from "@/lib/staff/channel-sync-actions";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const ORDER: BookingStatus[] = ["failed", "attention", "received", "imported", "resolved", "cancelled"];

/**
 * Channel manager, inbound half (migration 171). Connections and their keys, the map from the channel's room codes to room types, and the
 * reconciliation: what arrived, what could not be imported and why, where the channel's price is not ours, and bookings cancelled here but
 * live at the channel. Nothing here talks to an OTA; a channel manager posts bookings to /api/channels/inbound.
 */
export default async function ChannelsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const { supabase, loadFailed, property } = await loadChannelsContext(first(search.property));
  const heading = <PageTitle>Channels</PageTitle>;
  if (loadFailed || !property)
    return (
      <main className="max-w-4xl">
        {heading}
        <p className="mt-4 max-w-prose text-muted">Channels are managed by the owner and general manager.</p>
      </main>
    );
  const [connQ, mapQ, bookQ, typeQ, repQ] = await Promise.all([
    supabase
      .from("channel_connections")
      .select("id, channel, label, collects, status, prefix, last_inbound_at, last_feed_at")
      .eq("property_id", property.id)
      .order("created_at"),
    supabase.from("channel_room_map").select("connection_id, external_room_id, room_type_id"),
    supabase
      .from("channel_bookings")
      .select(
        "id, connection_id, external_id, status, guest_label, arrival_date, departure_date, channel_total_minor, reservation_id, error, note, attempts, created_at",
      )
      .eq("property_id", property.id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("room_types").select("id, name").eq("property_id", property.id).eq("status", "active").order("name"),
    supabase.rpc("channel_sync_report", { p_property: property.id }),
  ]);
  const conns = parseConnections(connQ.data);
  const map = parseMap(mapQ.data);
  const bookings = parseBookings(bookQ.data).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const types = ((typeQ.data ?? []) as { id: string; name: string }[]).map((t) => ({ id: t.id, name: t.name }));
  const report = parseChannelReport(repQ.data);
  const money = (m: number) => formatMoney(m, property.currency);
  const when = (iso: string) => formatDateTime(iso, property.timezone);
  const connLabel = (id: string) => conns.find((c) => c.id === id)?.label ?? "Connection";
  const live = conns.filter((c) => c.status !== "revoked");

  return (
    <main className="max-w-4xl">
      {heading}
      <PageIntro>
        Bookings from Booking.com, Expedia, Airbnb or any channel manager arrive at <code>/api/channels/inbound</code> with a connection
        key. Each one goes through the same booking code as a booking made here, so a room cannot be sold twice. A change at the channel is
        never applied by itself: it waits for you.
      </PageIntro>
      <div className="mt-5">
        <ChannelsNotice search={search} />
      </div>
      {(connQ.error || bookQ.error || repQ.error) && (
        <ErrorBanner className="mb-5">Some of this could not be loaded. Reload the page.</ErrorBanner>
      )}

      {report && (
        <section aria-label="Summary" className={cardClass}>
          <SectionTitle>Summary</SectionTitle>
          <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
            {ORDER.map((s) => (
              <span key={s}>
                {BOOKING_STATUS_LABEL[s]}: <strong>{report.counts[s] ?? 0}</strong>
              </span>
            ))}
          </p>
          {report.priceDifferences.length > 0 && (
            <div className="mt-3 text-sm">
              <p className="font-medium">The channel&apos;s price is not ours</p>
              <ul className="mt-1 grid gap-1">
                {report.priceDifferences.map((p) => (
                  <li key={p.id}>
                    {p.reference}: channel {formatMoney(p.channelTotalMinor, p.currency)}, our price{" "}
                    {formatMoney(p.ourTotalMinor, p.currency)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {report.cancelledHere.length > 0 && (
            <div className="mt-3 text-sm">
              <p className="font-medium">Cancelled here but still live at the channel: cancel them there too</p>
              <ul className="mt-1 grid gap-1">
                {report.cancelledHere.map((p) => (
                  <li key={p.id}>
                    {p.reference} (channel booking {p.externalId})
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section className="mt-8" aria-label="Bookings">
        <SectionTitle>Bookings from channels</SectionTitle>
        {bookings.length === 0 ? (
          <EmptyState className="mt-3">Nothing has arrived yet.</EmptyState>
        ) : (
          <ul className="mt-3 grid gap-2">
            {bookings.map((b) => (
              <li key={b.id} className={cardClass}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    {b.guest ?? "Guest not named"}{" "}
                    <span className="text-xs font-normal text-muted">
                      {connLabel(b.connectionId)} · {b.externalId}
                    </span>
                  </p>
                  <p className="text-sm">
                    <strong>{BOOKING_STATUS_LABEL[b.status]}</strong>
                    {b.arrival && b.departure ? ` · ${b.arrival} to ${b.departure}` : ""}
                    {b.channelTotalMinor !== null ? ` · channel total ${money(b.channelTotalMinor)}` : ""}
                  </p>
                </div>
                {b.error && <p className="text-sm text-red-800">{failureWords(b.error)}</p>}
                {b.note && <p className="text-sm text-muted">{b.note}</p>}
                <p className="text-xs text-muted">
                  Received {when(b.createdAt)}
                  {b.attempts > 1 ? ` · tried ${b.attempts} times` : ""}
                </p>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  {b.reservationId && (
                    <Link href={`/app/reservations/${b.reservationId}`} className="text-sm underline">
                      Open booking
                    </Link>
                  )}
                  {b.status === "failed" && (
                    <form action={retryBooking}>
                      <input type="hidden" name="bookingId" value={b.id} />
                      <PendingButton className={buttonPrimary}>Try again</PendingButton>
                    </form>
                  )}
                  {(b.status === "failed" || b.status === "attention") && (
                    <form action={resolveBooking} className="flex items-end gap-2">
                      <input type="hidden" name="bookingId" value={b.id} />
                      <input
                        name="note"
                        required
                        minLength={3}
                        maxLength={200}
                        placeholder="What you did"
                        className={`${inputClass} w-56`}
                        aria-label="What you did"
                      />
                      <PendingButton className={buttonQuiet}>Mark handled</PendingButton>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8" aria-label="Connections">
        <SectionTitle>Connections</SectionTitle>
        {conns.length === 0 ? (
          <EmptyState className="mt-3">No connections yet.</EmptyState>
        ) : (
          <ul className="mt-3 grid gap-3">
            {conns.map((c) => (
              <li key={c.id} className={cardClass}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    {c.label}{" "}
                    <span className="text-xs font-normal text-muted">
                      {CHANNEL_LABEL[c.channel]} · key chn_{c.prefix}_…
                    </span>
                  </p>
                  <p className="text-sm">
                    <strong>{c.status === "active" ? "Active" : c.status === "paused" ? "Paused" : "Revoked"}</strong> ·{" "}
                    {COLLECTS_LABEL[c.collects]}
                    {c.lastInboundAt ? ` · last heard ${when(c.lastInboundAt)}` : " · never heard from"}
                    {c.lastFeedAt ? ` · feed last read ${when(c.lastFeedAt)}` : ""}
                  </p>
                </div>
                {c.status !== "revoked" && (
                  <>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <form action={setConnectionStatus}>
                        <input type="hidden" name="connectionId" value={c.id} />
                        <input type="hidden" name="status" value={c.status === "active" ? "paused" : "active"} />
                        <PendingButton className={buttonQuiet}>{c.status === "active" ? "Pause" : "Resume"}</PendingButton>
                      </form>
                      <form action={setConnectionStatus}>
                        <input type="hidden" name="connectionId" value={c.id} />
                        <input type="hidden" name="status" value="revoked" />
                        <PendingButton className={buttonQuiet}>Revoke key</PendingButton>
                      </form>
                    </div>
                    <div className="mt-3">
                      <p className="text-xs font-medium">Room codes from this channel</p>
                      <ul className="mt-1 grid gap-1 text-sm">
                        {map
                          .filter((m) => m.connectionId === c.id)
                          .map((m) => (
                            <li key={m.externalRoomId} className="flex flex-wrap items-center gap-2">
                              <code>{m.externalRoomId}</code> is {types.find((t) => t.id === m.roomTypeId)?.name ?? "a room type"}
                              <form action={removeMapping}>
                                <input type="hidden" name="connectionId" value={c.id} />
                                <input type="hidden" name="code" value={m.externalRoomId} />
                                <PendingButton className={buttonQuiet}>Remove</PendingButton>
                              </form>
                            </li>
                          ))}
                      </ul>
                      <form action={saveMapping} className="mt-2 flex flex-wrap items-end gap-2">
                        <input type="hidden" name="connectionId" value={c.id} />
                        <input
                          name="code"
                          required
                          maxLength={80}
                          placeholder="Channel's room code"
                          className={`${inputClass} w-44`}
                          aria-label="Channel's room code"
                        />
                        <select name="roomTypeId" required className={inputClass} aria-label="Room type">
                          {types.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                        <PendingButton className={buttonQuiet}>Save code</PendingButton>
                      </form>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className={`${cardClass} mt-3`}>
          <p className="mb-2 text-xs text-muted">{live.length} of 5 connections in use.</p>
          <ChannelCreateGate propertyId={property.id} />
        </div>
      </section>
    </main>
  );
}

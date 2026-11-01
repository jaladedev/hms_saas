import { buttonPrimary, inputClass } from "@/components/staff/ui";
import { PRIORITY_LABEL, REQUEST_PRIORITIES, STATUS_LABEL } from "@/lib/staff/maintenance";
import { reportRequest } from "@/lib/staff/maintenance-actions";

const PRIORITY_CHIP: Record<string, string> = {
  urgent: "bg-critical/10 text-critical", high: "bg-pending/10 text-pending", normal: "bg-ink/10 text-muted", low: "bg-ink/5 text-muted",
};
const STATUS_CHIP: Record<string, string> = {
  open: "bg-pending/10 text-pending", in_progress: "bg-navy-800/10 text-navy-800", resolved: "bg-primary/10 text-primary-strong", cancelled: "bg-ink/10 text-muted",
};

export function PriorityChip({ priority }: { priority: string }) {
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${PRIORITY_CHIP[priority] ?? PRIORITY_CHIP.normal}`}>{PRIORITY_LABEL[priority] ?? priority}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_CHIP[status] ?? "bg-ink/10 text-muted"}`}>{STATUS_LABEL[status] ?? status}</span>;
}

type Place = { id: string; name: string };
type RoomOption = { id: string; property_id: string; room_number: string; floor: number | null };
type Person = { user_id: string; full_name: string };

/**
 * The "Report a fault" form. Anyone with maintenance.view may report. The room, or a place for a fault outside the
 * rooms, is required; the property comes from the room (the action looks it up), or from the place's property. A due
 * time and an assignee are for people who manage maintenance, and are offered only where there is a single hotel to
 * read the time and the staff list in. The idempotency key makes a double tap one request.
 */
export function ReportForm({ properties, rooms, from, idempotencyKey, fixedRoomId, people, canManage }: {
  properties: Place[];
  rooms: RoomOption[];
  from: "list" | "rooms";
  idempotencyKey: string;
  /** On a room card: the room is fixed and the place box is not offered. */
  fixedRoomId?: string;
  people?: Person[];
  canManage?: boolean;
}) {
  const single = properties.length === 1;
  const fixed = fixedRoomId ? rooms.find((r) => r.id === fixedRoomId) : undefined;
  const propertyId = fixed?.property_id ?? (single ? properties[0]?.id : undefined);
  const idp = fixedRoomId ?? "new";
  return (
    <form action={reportRequest} className="grid max-w-2xl gap-3 rounded border border-line bg-white p-3 sm:grid-cols-2">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="from" value={from} />
      {propertyId ? <input type="hidden" name="propertyId" value={propertyId} /> : null}

      {fixed ? <input type="hidden" name="roomId" value={fixed.id} /> : (
        <>
          <label className="text-sm" htmlFor={`mt-room-${idp}`}>
            <span className="mb-1 block text-muted">Room</span>
            <select id={`mt-room-${idp}`} name="roomId" className={inputClass} defaultValue="">
              <option value="">Not in a room</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.room_number}{r.floor !== null ? `, floor ${r.floor}` : ""}</option>)}
            </select>
          </label>
          <label className="text-sm" htmlFor={`mt-loc-${idp}`}>
            <span className="mb-1 block text-muted">Or the place, if it is not in a room</span>
            <input id={`mt-loc-${idp}`} name="location" maxLength={100} placeholder="Lobby, lift, generator" className={inputClass} />
          </label>
          {!single && (
            <label className="text-sm sm:col-span-2" htmlFor={`mt-prop-${idp}`}>
              <span className="mb-1 block text-muted">Hotel (for a place that is not in a room)</span>
              <select id={`mt-prop-${idp}`} name="propertyId" className={inputClass} defaultValue={properties[0]?.id}>
                {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
        </>
      )}

      <label className="text-sm sm:col-span-2" htmlFor={`mt-title-${idp}`}>
        <span className="mb-1 block text-muted">What is wrong</span>
        <input id={`mt-title-${idp}`} name="title" required maxLength={120} placeholder="Tap leaking in the bathroom" className={inputClass} />
      </label>
      <label className="text-sm sm:col-span-2" htmlFor={`mt-desc-${idp}`}>
        <span className="mb-1 block text-muted">More detail (optional)</span>
        <textarea id={`mt-desc-${idp}`} name="description" maxLength={2000} rows={3} className={inputClass} />
      </label>
      <label className="text-sm" htmlFor={`mt-prio-${idp}`}>
        <span className="mb-1 block text-muted">Priority</span>
        <select id={`mt-prio-${idp}`} name="priority" defaultValue="normal" className={inputClass}>
          {REQUEST_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </select>
      </label>
      {canManage && single && (
        <>
          <label className="text-sm" htmlFor={`mt-due-${idp}`}>
            <span className="mb-1 block text-muted">Due (optional, hotel time)</span>
            <input id={`mt-due-${idp}`} name="due" type="datetime-local" className={inputClass} />
          </label>
          <label className="text-sm sm:col-span-2" htmlFor={`mt-who-${idp}`}>
            <span className="mb-1 block text-muted">Give it to (optional)</span>
            <select id={`mt-who-${idp}`} name="assignedTo" defaultValue="" className={inputClass}>
              <option value="">Nobody yet</option>
              {(people ?? []).map((s) => <option key={s.user_id} value={s.user_id}>{s.full_name}</option>)}
            </select>
          </label>
        </>
      )}
      <div className="sm:col-span-2"><button type="submit" className={buttonPrimary}>Report fault</button></div>
    </form>
  );
}

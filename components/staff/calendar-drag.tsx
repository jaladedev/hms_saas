"use client";

import { useEffect, useRef, useState } from "react";
import { buttonPrimary, buttonQuiet, inputClass, SectionTitle } from "@/components/staff/ui";
import { formatDate } from "@/lib/guest-site/format";
import { canDropOn, moveEffective, moveSummary } from "@/lib/staff/calendar-move";
import { moveStayFromCalendar } from "@/lib/staff/calendar-actions";

type Pending = {
  rr: string; label: string; fromNumber: string; toId: string; toNumber: string;
  effective: string; start: string; end: string; key: string;
};

const OVER = ["bg-primary/10"];

/**
 * Drag a booking's bar onto another room of the same type to move the guest. It works on the server-drawn calendar table
 * through data attributes (no state of its own about bookings): a bar carries data-move-*, a room row data-room-*, a night
 * cell data-date. A drop opens a confirmation with the sentence from `moveSummary` and a required reason, then submits the
 * same transfer_room call as the booking page. Mouse drag only: on a phone or by keyboard, open the booking and use
 * "Move to another room" there. The database decides on submit; nothing here is trusted.
 */
export function CalendarDrag({ containerId, today, property, from, days }: { containerId: string; today: string; property: string; from: string; days: number }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    const box = document.getElementById(containerId);
    if (!box) return;
    let source: { rr: string; label: string; roomId: string; typeId: string; roomNumber: string; start: string; end: string } | null = null;
    let lit: HTMLElement | null = null;

    const targetRow = (el: EventTarget | null): HTMLElement | null => {
      const row = (el as HTMLElement | null)?.closest<HTMLElement>("tr[data-room-id]") ?? null;
      if (!row || !source) return null;
      const target = { id: row.dataset.roomId ?? "", room_type_id: row.dataset.roomType ?? "", operational_status: row.dataset.roomStatus ?? "" };
      return canDropOn({ roomId: source.roomId, roomTypeId: source.typeId }, target) ? row : null;
    };
    const unlight = () => { lit?.classList.remove(...OVER); lit = null; };

    const onStart = (e: DragEvent) => {
      const bar = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-move-rr]");
      if (!bar || !e.dataTransfer) return;
      source = {
        rr: bar.dataset.moveRr!, label: bar.dataset.moveLabel ?? "this booking", roomId: bar.dataset.moveRoom!, typeId: bar.dataset.moveType!,
        roomNumber: bar.dataset.moveRoomNumber ?? "", start: bar.dataset.moveStart!, end: bar.dataset.moveEnd!,
      };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", source.label);
    };
    const onOver = (e: DragEvent) => {
      const row = targetRow(e.target);
      if (!row) { unlight(); return; }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      if (lit !== row) { unlight(); row.classList.add(...OVER); lit = row; }
    };
    const onDrop = (e: DragEvent) => {
      const row = targetRow(e.target);
      unlight();
      if (!row || !source) return;
      e.preventDefault();
      const cell = (e.target as HTMLElement).closest<HTMLElement>("td[data-date]");
      const effective = moveEffective(source.start, source.end, today, cell?.dataset.date ?? null);
      if (!effective) return;
      setPending({
        rr: source.rr, label: source.label, fromNumber: source.roomNumber, toId: row.dataset.roomId!, toNumber: row.dataset.roomNumber ?? "",
        effective, start: source.start, end: source.end, key: crypto.randomUUID(),
      });
      source = null;
    };
    const onEnd = () => { unlight(); source = null; };

    box.addEventListener("dragstart", onStart);
    box.addEventListener("dragover", onOver);
    box.addEventListener("drop", onDrop);
    box.addEventListener("dragend", onEnd);
    return () => {
      box.removeEventListener("dragstart", onStart);
      box.removeEventListener("dragover", onOver);
      box.removeEventListener("drop", onDrop);
      box.removeEventListener("dragend", onEnd);
    };
  }, [containerId, today]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (pending && !d.open) d.showModal();
    if (!pending && d.open) d.close();
  }, [pending]);

  return (
    <dialog ref={dialog} onClose={() => setPending(null)} aria-labelledby="move-title" className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded border border-line bg-white p-5 text-ink backdrop:bg-ink/40">
      {pending && (
        <form action={moveStayFromCalendar} className="space-y-4">
          <input type="hidden" name="reservationRoomId" value={pending.rr} />
          <input type="hidden" name="newRoomId" value={pending.toId} />
          <input type="hidden" name="effective" value={pending.effective} />
          <input type="hidden" name="idempotencyKey" value={pending.key} />
          <input type="hidden" name="property" value={property} />
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="days" value={String(days)} />
          <SectionTitle id="move-title">Move guest to room {pending.toNumber}?</SectionTitle>
          <p className="text-sm">
            {moveSummary({ label: pending.label, from: pending.fromNumber, to: pending.toNumber, effective: pending.effective, start: pending.start, end: pending.end, dateText: formatDate })}
          </p>
          <div>
            <label htmlFor="move-reason" className="block text-sm">Reason</label>
            <textarea id="move-reason" name="reason" required maxLength={500} rows={2} autoFocus className={inputClass} />
          </div>
          <div className="flex gap-2">
            <button type="submit" className={buttonPrimary}>Move guest</button>
            <button type="button" onClick={() => setPending(null)} className={buttonQuiet}>Cancel</button>
          </div>
        </form>
      )}
    </dialog>
  );
}

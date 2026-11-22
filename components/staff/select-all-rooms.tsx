"use client";

/**
 * "Select all" for the rooms of one room type, beside the per-room tick boxes that belong to the property's bulk form.
 * It only ticks or unticks boxes on the page; nothing is sent until the person presses Apply. Without scripts the boxes still work
 * one by one.
 */
export function SelectAllRooms({ group }: { group: string }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="h-4 w-4"
        onChange={(e) => {
          const on = e.currentTarget.checked;
          document.querySelectorAll<HTMLInputElement>(`input[data-room-group="${group}"]`).forEach((box) => {
            box.checked = on;
          });
        }}
      />
      Tick all rooms of this type
    </label>
  );
}

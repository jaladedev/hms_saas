import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonPrimary, buttonQuiet, cardClass, ErrorBanner, linkClass, Notice, PageTitle, SectionTitle } from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatDateTime } from "@/lib/staff/format";
import { addTaskPhoto, removeTaskPhoto } from "@/lib/staff/housekeeping-photo-actions";
import {
  MAX_PHOTOS_PER_KIND,
  PHOTO_KIND_LABEL,
  PHOTO_KINDS,
  TASK_PHOTO_ACCEPT,
  TASK_PHOTO_BUCKET,
  TASK_PHOTO_LINK_SECONDS,
  taskPhotoLabel,
  type PhotoKind,
} from "@/lib/staff/housekeeping-photos";
import { PRIORITY_LABEL, TASK_TYPE_LABEL } from "@/lib/staff/housekeeping-tasks";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_LABEL: Record<string, string> = { open: "Open", in_progress: "In progress", done: "Done", cancelled: "Cancelled" };

type Task = {
  id: string;
  property_id: string;
  room_id: string;
  task_type: string;
  status: string;
  priority: string;
  notes: string | null;
  completion_note: string | null;
  created_at: string;
  completed_at: string | null;
};
type Photo = { id: string; kind: PhotoKind; storage_path: string; size_bytes: number; created_at: string };

/**
 * One housekeeping task, with its before and after pictures (migration 181). The task and the pictures come through row-level
 * security (people who may see housekeeping); each file is shown by a short-lived signed link made here, so the row's access rule
 * is the file's access rule. The bucket is private; nobody reaches a file by address. Buttons mirror the database rules.
 */
export default async function HousekeepingTaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const search = await searchParams;
  if (!UUID.test(id)) notFound();
  const supabase = await createClient();

  const taskQ = await supabase
    .from("housekeeping_tasks")
    .select("id, property_id, room_id, task_type, status, priority, notes, completion_note, created_at, completed_at")
    .eq("id", id)
    .maybeSingle();
  if (taskQ.error) {
    return (
      <main className="max-w-3xl">
        <PageTitle>Task</PageTitle>
        <ErrorBanner className="mt-6">This task could not be loaded. Reload the page.</ErrorBanner>
      </main>
    );
  }
  const task = taskQ.data as Task | null;
  if (!task) notFound();

  const [roomQ, propQ, photoQ, canAddQ, canRemoveQ] = await Promise.all([
    supabase.from("rooms").select("room_number, floor").eq("id", task.room_id).maybeSingle(),
    supabase.from("properties").select("timezone").eq("id", task.property_id).maybeSingle(),
    supabase
      .from("housekeeping_task_photos")
      .select("id, kind, storage_path, size_bytes, created_at")
      .eq("task_id", task.id)
      .order("created_at"),
    supabase.rpc("hk_photo_allowed", { p_task: task.id, p_adding: true }),
    supabase.rpc("hk_photo_allowed", { p_task: task.id, p_adding: false }),
  ]);
  const room = roomQ.data as { room_number: string; floor: number | null } | null;
  const tz = (propQ.data as { timezone: string } | null)?.timezone ?? "UTC";
  const photos = (photoQ.data ?? []) as Photo[];
  const canAdd = canAddQ.data === true;
  const canRemove = canRemoveQ.data === true;

  const links = new Map<string, string>();
  if (photos.length > 0) {
    try {
      const { data: signed } = await createServiceClient()
        .storage.from(TASK_PHOTO_BUCKET)
        .createSignedUrls(
          photos.map((p) => p.storage_path),
          TASK_PHOTO_LINK_SECONDS,
        );
      for (const s of signed ?? []) if (s.path && s.signedUrl && !s.error) links.set(s.path, s.signedUrl);
    } catch {
      // Storage is unavailable: the list still shows, with "Photo unavailable" in place of each picture.
    }
  }

  return (
    <main className="max-w-3xl">
      <p className="text-sm">
        <Link href="/app/housekeeping" className={linkClass}>
          Housekeeping
        </Link>
      </p>
      <div className="mt-4">
        <Notice search={search} currency="NGN" />
      </div>
      <PageTitle className="mt-2">
        Room {room?.room_number ?? ""}
        <span className="ml-3 text-base font-normal text-muted">{TASK_TYPE_LABEL[task.task_type] ?? task.task_type}</span>
      </PageTitle>
      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary-strong">
          {STATUS_LABEL[task.status] ?? task.status}
        </span>
        <span className="text-muted">{PRIORITY_LABEL[task.priority] ?? task.priority} priority</span>
        {room?.floor != null && <span className="text-muted">Floor {room.floor}</span>}
        <span className="text-muted">Created {formatDateTime(task.created_at, tz)}</span>
        {task.completed_at && <span className="text-muted">Finished {formatDateTime(task.completed_at, tz)}</span>}
      </p>
      {task.notes && <p className="mt-3 max-w-prose text-sm">{task.notes}</p>}
      {task.completion_note && <p className="mt-2 max-w-prose text-sm text-muted">Finishing note: {task.completion_note}</p>}

      {PHOTO_KINDS.map((kind) => {
        const mine = photos.filter((p) => p.kind === kind);
        return (
          <section key={kind} className="mt-8">
            <SectionTitle>
              {PHOTO_KIND_LABEL[kind]} photos ({mine.length}/{MAX_PHOTOS_PER_KIND})
            </SectionTitle>
            {mine.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No {kind} photo yet.</p>
            ) : (
              <ul className="mt-2 grid gap-3 sm:grid-cols-3">
                {mine.map((p, i) => {
                  const href = links.get(p.storage_path);
                  return (
                    <li key={p.id} className={`${cardClass} text-sm`}>
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={href} alt={`${PHOTO_KIND_LABEL[kind]} photo ${i + 1}`} className="h-32 w-full rounded object-cover" />
                        </a>
                      ) : (
                        <p className="flex h-32 items-center justify-center text-muted">Photo unavailable</p>
                      )}
                      <p className="mt-2 text-xs text-muted">
                        {taskPhotoLabel(kind, i + 1, p.size_bytes)}, added {formatDateTime(p.created_at, tz)}
                      </p>
                      {canRemove && (
                        <form action={removeTaskPhoto} className="mt-2">
                          <input type="hidden" name="photoId" value={p.id} />
                          <PendingButton className={buttonQuiet} pendingLabel="Removing…">
                            Remove
                          </PendingButton>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {canAdd && mine.length < MAX_PHOTOS_PER_KIND && (
              <form action={addTaskPhoto} className="mt-3 flex flex-wrap items-end gap-3">
                <input type="hidden" name="taskId" value={task.id} />
                <input type="hidden" name="kind" value={kind} />
                <div>
                  <label htmlFor={`photo-${kind}`} className="block text-sm">
                    Add a {kind} photo
                  </label>
                  <input
                    id={`photo-${kind}`}
                    name="photo"
                    type="file"
                    required
                    accept={TASK_PHOTO_ACCEPT}
                    capture="environment"
                    className="mt-1 block text-sm"
                  />
                </div>
                <PendingButton className={buttonPrimary} pendingLabel="Uploading…">
                  Add photo
                </PendingButton>
              </form>
            )}
          </section>
        );
      })}
      <p className="mt-6 max-w-prose text-xs text-muted">
        Up to 3 pictures of each kind, JPEG, PNG or WebP, 5 MB each. Only people who may see housekeeping can see them, and a link opens for
        five minutes. A task assigned to someone else can only be changed by that person or by someone who may assign work. A picture
        changes nothing about the task.
      </p>
    </main>
  );
}

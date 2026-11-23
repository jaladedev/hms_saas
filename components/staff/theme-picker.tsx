import { buttonPrimary, buttonQuiet, inputClass } from "@/components/staff/ui";
import { ThemeEditor } from "@/components/staff/theme-editor";
import { PendingButton } from "@/components/ui/pending-button";
import { PhotoPicker } from "@/components/ui/photo-picker";
import {
  discardThemeDraft,
  publishThemeDraft,
  removeThemeImage,
  saveAndPublishTheme,
  saveThemeDraft,
  uploadThemeImage,
} from "@/lib/staff/hotel-profile-actions";
import { photoUrl } from "@/lib/staff/room-photos";
import {
  draftChanges,
  joinChanges,
  THEME_IMAGE_KINDS,
  THEME_IMAGE_LABEL,
  THEME_IMAGE_LIMIT_TEXT,
  type ThemeDraftRow,
  type ThemeImageKind,
  type ThemeLook,
} from "@/lib/staff/theme-images";

const IMAGE_HELP: Record<ThemeImageKind, string> = {
  favicon: "The small icon in the browser tab on your website. A square PNG, JPEG or WebP works best.",
  hero: "A wide banner above the top of your home page. A landscape JPEG, PNG or WebP works best.",
};

/**
 * Chooses the hotel's look: theme, optional main colour, fonts and corners with a live preview (the client part is `ThemeEditor`),
 * plus a favicon and a hero image. Everything here edits a DRAFT (migration 182): the website and the staff screens keep the
 * published look until the draft is published. This wrapper supplies the server actions, the draft banner and the image forms.
 */
export function ThemePicker({
  propertyId,
  name,
  live,
  draft,
  supabaseUrl,
}: {
  propertyId: string;
  name: string;
  live: ThemeLook;
  draft: ThemeDraftRow | null;
  supabaseUrl: string;
}) {
  const base: ThemeLook = draft ?? live;
  const changes = draft ? draftChanges(live, draft) : [];
  return (
    <div className="mt-8">
      {draft ? (
        <div role="status" className="rounded border border-primary bg-white p-4">
          <p className="text-sm font-medium">You have an unpublished draft</p>
          <p className="mt-1 max-w-prose text-sm text-muted">
            {changes.length > 0
              ? `It changes the ${joinChanges(changes)}. Guests and staff still see the published look.`
              : "It matches the published look, so publishing changes nothing. Guests and staff see the published look."}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <form action={publishThemeDraft}>
              <input type="hidden" name="propertyId" value={propertyId} />
              <PendingButton className={buttonPrimary} pendingLabel="Publishing…">
                Publish draft
              </PendingButton>
            </form>
            <form action={discardThemeDraft}>
              <input type="hidden" name="propertyId" value={propertyId} />
              <PendingButton className={buttonQuiet} pendingLabel="Discarding…">
                Discard draft
              </PendingButton>
            </form>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted">
          No draft. Changes below are saved as a draft first, and nothing changes for guests until you publish.
        </p>
      )}

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        {THEME_IMAGE_KINDS.map((kind) => {
          const path = kind === "favicon" ? base.favicon_path : base.hero_path;
          const livePath = kind === "favicon" ? live.favicon_path : live.hero_path;
          return (
            <div key={kind}>
              <h3 className="text-sm font-medium">{THEME_IMAGE_LABEL[kind]}</h3>
              <p className="mt-1 text-xs text-muted">{IMAGE_HELP[kind]}</p>
              {path ? (
                <div className="mt-2 flex items-center gap-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photoUrl(supabaseUrl, path)}
                    alt={`${name} ${THEME_IMAGE_LABEL[kind].toLowerCase()}${draft ? " (draft)" : ""}`}
                    className={
                      kind === "favicon"
                        ? "h-10 w-10 rounded border border-line object-contain"
                        : "h-20 max-w-48 rounded border border-line object-cover"
                    }
                  />
                  <form action={removeThemeImage}>
                    <input type="hidden" name="propertyId" value={propertyId} />
                    <input type="hidden" name="kind" value={kind} />
                    <PendingButton className={buttonQuiet} pendingLabel="Removing…">
                      Remove from draft
                    </PendingButton>
                  </form>
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted">
                  None{livePath && draft ? " in the draft (the published look still has one)" : ""}.
                </p>
              )}
              <form action={uploadThemeImage} className="mt-3 flex flex-wrap items-end gap-3">
                <input type="hidden" name="propertyId" value={propertyId} />
                <input type="hidden" name="kind" value={kind} />
                <div>
                  <label htmlFor={`ti-${kind}-${propertyId}`} className="block text-sm">
                    {path ? `Replace the ${THEME_IMAGE_LABEL[kind].toLowerCase()}` : `Add a ${THEME_IMAGE_LABEL[kind].toLowerCase()}`}
                  </label>
                  <PhotoPicker
                    id={`ti-${kind}-${propertyId}`}
                    name="image"
                    required
                    className={inputClass}
                    previewClassName={kind === "favicon" ? "h-10 w-10 !object-contain" : "h-20 max-w-48"}
                  />
                  <p className="mt-1 text-xs text-muted">JPEG, PNG or WebP, up to {THEME_IMAGE_LIMIT_TEXT[kind]}. Goes into the draft.</p>
                </div>
                <PendingButton className={buttonQuiet} pendingLabel="Uploading…" progress>
                  Add to draft
                </PendingButton>
              </form>
            </div>
          );
        })}
      </div>

      <ThemeEditor
        key={draft?.updated_at ?? "published"}
        action={saveThemeDraft}
        publishAction={saveAndPublishTheme}
        hasDraft={draft !== null}
        propertyId={propertyId}
        name={name}
        current={base.theme}
        primary={base.theme_primary}
        fontDisplay={base.theme_font_display}
        fontBody={base.theme_font_body}
        radius={base.theme_radius}
        buttonClass={buttonPrimary}
        quietButtonClass={buttonQuiet}
        inputClass={inputClass}
      />
    </div>
  );
}

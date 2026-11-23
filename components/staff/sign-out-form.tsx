"use client";

import { useRef, useState } from "react";
import { clearOfflineData } from "@/lib/offline/client";
import { isOffline } from "@/lib/offline/connection";

/**
 * The sign-out form. Saved pages are removed from this computer first, so the next person at a shared laptop cannot open
 * the last person's guests. Offline, signing out cannot reach the server, so the saved pages are removed but the person
 * is told they are still signed in rather than being sent to a page that cannot load.
 */
export function SignOutForm({ action }: { action: () => Promise<void> }) {
  const formRef = useRef<HTMLFormElement>(null);
  const cleared = useRef(false);
  const [offlineNote, setOfflineNote] = useState(false);

  return (
    <form
      ref={formRef}
      action={action}
      data-allow-offline
      className="mt-2"
      onSubmit={(e) => {
        if (cleared.current) return;
        e.preventDefault();
        const offline = isOffline();
        void clearOfflineData().finally(() => {
          if (offline) {
            setOfflineNote(true);
            return;
          }
          cleared.current = true;
          formRef.current?.requestSubmit();
        });
      }}
    >
      <button
        type="submit"
        className="text-white underline underline-offset-2 hover:text-white/80 focus-visible:outline-2 focus-visible:outline-white"
      >
        Sign out
      </button>
      {offlineNote && (
        <p role="status" className="mt-1 text-xs text-white/70">
          You are offline, so you are still signed in. Saved pages were removed from this computer. Sign out again when the connection is
          back.
        </p>
      )}
    </form>
  );
}

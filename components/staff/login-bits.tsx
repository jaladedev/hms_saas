"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { buttonPrimary, inputClass } from "./ui";

export function PasswordField() {
  const [shown, setShown] = useState(false);
  return (
    <div>
      <label htmlFor="password" className="block text-sm font-medium">Password</label>
      <div className="mt-1 flex gap-2">
        <input
          id="password" name="password" type={shown ? "text" : "password"} required maxLength={200}
          autoComplete="current-password" className={inputClass}
        />
        <button
          type="button" onClick={() => setShown((s) => !s)} aria-pressed={shown}
          className="shrink-0 rounded border border-line bg-white px-3 text-sm hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

export function SubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${buttonPrimary} w-full py-2`}>
      {pending ? "Signing in…" : children}
    </button>
  );
}

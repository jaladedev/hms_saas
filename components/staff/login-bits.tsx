"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { buttonPrimary, inputClass } from "./ui";

export function PasswordField({
  name = "password", label = "Password", autoComplete = "current-password",
}: { name?: string; label?: string; autoComplete?: "current-password" | "new-password" }) {
  const [shown, setShown] = useState(false);
  return (
    <div>
      <label htmlFor={name} className="block text-sm font-medium">{label}</label>
      <div className="mt-1 flex gap-2">
        <input
          id={name} name={name} type={shown ? "text" : "password"} required maxLength={200}
          autoComplete={autoComplete} className={inputClass}
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

export function SubmitButton({ children, pendingLabel = "Signing in…" }: { children: React.ReactNode; pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${buttonPrimary} w-full py-2`}>
      {pending ? pendingLabel : children}
    </button>
  );
}

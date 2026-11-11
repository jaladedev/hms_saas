"use client";

import { useEffect, useRef, useState } from "react";
import { formatBytes, pickedPhotoProblem } from "@/lib/staff/room-photos";

/**
 * A file field for a picture: shows a preview of what was chosen, its name and size, and says at once if the type or size
 * is wrong (and holds the form back with the browser's own validity message). The server checks again.
 */
export function PhotoPicker({
  id,
  name,
  required = false,
  className,
  previewClassName = "h-24 w-40",
}: {
  id: string;
  name: string;
  required?: boolean;
  className?: string;
  previewClassName?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const url = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (url.current) URL.revokeObjectURL(url.current);
    };
  }, []);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    const file = e.target.files?.[0];
    const issue = file ? pickedPhotoProblem(file) : null;
    e.target.setCustomValidity(issue ?? "");
    setProblem(issue);
    if (!file || issue) {
      setPreview(null);
      return;
    }
    url.current = URL.createObjectURL(file);
    setPreview({ url: url.current, label: `${file.name} · ${formatBytes(file.size)}` });
  }

  return (
    <div>
      <input
        ref={input}
        id={id}
        name={name}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        required={required}
        onChange={onChange}
        aria-describedby={problem ? `${id}-problem` : undefined}
        aria-invalid={problem ? true : undefined}
        className={className}
      />
      {problem ? (
        <p id={`${id}-problem`} role="alert" className="mt-1 text-xs text-critical">
          {problem}
        </p>
      ) : null}
      {preview ? (
        <figure className="mt-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview.url}
            alt="Preview of the chosen picture"
            className={`${previewClassName} rounded border border-line object-cover`}
          />
          <figcaption className="mt-1 text-xs text-muted">{preview.label}</figcaption>
        </figure>
      ) : null}
    </div>
  );
}

import Link from "next/link";
import { PasswordField, SubmitButton } from "@/components/staff/login-bits";
import { MIN_PASSWORD_LENGTH, resetErrorMessage } from "@/lib/staff/auth";
import { updatePassword } from "@/lib/staff/auth-actions";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ResetPassword({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const code = one(search.err);
  const error = resetErrorMessage(code);

  // No session means the link was never opened here, was used already, or has expired.
  if (!data.user || code === "expired") {
    return (
      <main className="mx-auto max-w-sm px-4 py-24">
        <p className="font-display text-xl text-navy-900">HMS</p>
        <h1 className="mt-6 font-display text-3xl">This link will not work</h1>
        <p className="mt-2 text-sm text-muted">
          Recovery links work once, for a short time, and in the browser where you asked for them. Ask for a new one and open it there.
        </p>
        <p className="mt-6 text-sm"><Link href="/forgot-password" className="text-primary-strong underline underline-offset-2">Send a new link</Link></p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-sm px-4 py-24">
      <p className="font-display text-xl text-navy-900">HMS</p>
      <h1 className="mt-6 font-display text-3xl">Choose a new password</h1>
      <p className="mt-2 text-sm text-muted">At least {MIN_PASSWORD_LENGTH} characters. You will be signed out everywhere and asked to sign in again.</p>
      {error && <p role="alert" className="mt-6 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">{error}</p>}
      <form action={updatePassword} className="mt-6 space-y-4">
        <PasswordField name="password" label="New password" autoComplete="new-password" />
        <PasswordField name="confirm" label="Type it again" autoComplete="new-password" />
        <SubmitButton pendingLabel="Saving…">Change password</SubmitButton>
      </form>
    </main>
  );
}

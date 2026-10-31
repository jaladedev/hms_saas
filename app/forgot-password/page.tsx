import Link from "next/link";
import { SubmitButton } from "@/components/staff/login-bits";
import { inputClass } from "@/components/staff/ui";
import { requestPasswordReset } from "@/lib/staff/auth-actions";

export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const PROBLEM: Record<string, string> = {
  rate: "Too many requests. Wait a few minutes and try again.",
  unavailable: "Sending is not available right now. Try again in a moment.",
};

export default async function ForgotPassword({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const sent = one(search.sent) === "1";
  const problem = PROBLEM[one(search.err) ?? ""];

  return (
    <main className="mx-auto max-w-sm px-4 py-24">
      <p className="font-display text-xl text-navy-900">HMS</p>
      <h1 className="mt-6 font-display text-3xl">Reset your password</h1>

      {sent ? (
        <>
          <p role="status" className="mt-6 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-primary-strong">
            If that email belongs to an account, a link to choose a new password is on its way. It can take a few minutes. Open it in this same browser.
          </p>
          <p className="mt-6 text-sm"><Link href="/login" className="text-primary-strong underline underline-offset-2">Back to sign in</Link></p>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted">Enter the email you sign in with and we will send you a link.</p>
          {problem && <p role="alert" className="mt-6 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">{problem}</p>}
          <form action={requestPasswordReset} className="mt-6 space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium">Email</label>
              <input id="email" name="email" type="email" required maxLength={254} autoComplete="username" autoFocus
                autoCapitalize="none" spellCheck={false} className={`${inputClass} mt-1`} />
            </div>
            <SubmitButton pendingLabel="Sending…">Send recovery link</SubmitButton>
          </form>
          <p className="mt-4 text-sm"><Link href="/login" className="text-primary-strong underline underline-offset-2">Back to sign in</Link></p>
        </>
      )}
    </main>
  );
}

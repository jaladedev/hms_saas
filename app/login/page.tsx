import { PasswordField, SubmitButton } from "@/components/staff/login-bits";
import { inputClass } from "@/components/staff/ui";
import { safeNext, signInErrorMessage } from "@/lib/staff/auth";
import { signIn } from "@/lib/staff/auth-actions";

export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function Login({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const error = signInErrorMessage(one(search.err));
  const next = safeNext(one(search.next));

  return (
    <main className="mx-auto max-w-sm px-4 py-24">
      <p className="font-display text-xl text-navy-900">HMS</p>
      <h1 className="mt-6 font-display text-3xl">Staff sign in</h1>
      <p className="mt-2 text-sm text-muted">Use the email and password your hotel gave you.</p>

      {error && (
        <p role="alert" className="mt-6 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">{error}</p>
      )}

      <form action={signIn} className="mt-6 space-y-4">
        {next !== "/app" && <input type="hidden" name="next" value={next} />}
        <div>
          <label htmlFor="email" className="block text-sm font-medium">Email</label>
          <input
            id="email" name="email" type="email" required maxLength={254} autoComplete="username" autoFocus
            autoCapitalize="none" spellCheck={false} className={`${inputClass} mt-1`}
          />
        </div>
        <PasswordField />
        <SubmitButton>Sign in</SubmitButton>
      </form>
    </main>
  );
}

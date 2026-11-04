import type { Database as Generated } from "@/types/database";

/**
 * The generated `Database` type with one correction: every database function argument also accepts null.
 *
 * `supabase gen types` marks a function argument as a required non-null value unless the SQL gives it a default,
 * but a Postgres function takes null for any argument unless it is declared `strict`. Our functions are called with
 * null on purpose (an optional note, an unassigned person), so without this the generated types refuse correct code.
 * Argument names and which arguments are required stay checked. The generated file is not edited, so
 * `npm run db:types` can overwrite it freely.
 */
type NullableArgs<A> = { [K in keyof A]: A[K] | null };

type Functions = Generated["public"]["Functions"];

export type Database = Omit<Generated, "public"> & {
  public: Omit<Generated["public"], "Functions"> & {
    Functions: { [F in keyof Functions]: Omit<Functions[F], "Args"> & { Args: NullableArgs<Functions[F]["Args"]> } };
  };
};

import type { Instrumentation } from "next";

/** Next calls this for every error thrown while rendering a page, running a route or running a server action. */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { reportError } = await import("@/lib/observability/report");
  const digest = (err as { digest?: string } | null)?.digest;
  await reportError(err, {
    routePath: context.routePath,
    path: request.path,
    method: request.method,
    routeType: context.routeType,
    routerKind: context.routerKind,
    digest,
  });
};

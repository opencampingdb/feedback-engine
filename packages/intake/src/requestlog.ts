/**
 * One log line per request for Workers Logs: method, path, status, the
 * refusal code a 4xx or 5xx answer carries in its `error` field, the
 * attestation platform header, and the time taken. Never the body, query
 * string, other headers or any secret: those stay out of the logs.
 */
export interface RequestLine {
  method: string;
  path: string;
  status: number;
  error?: string;
  platform?: string;
  ms: number;
}

const PLATFORMS = new Set(["ios", "android"]);
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** The refusal code in a JSON error answer, or undefined. Reads a clone, so the answer is untouched. */
async function errorCode(response: Response): Promise<string | undefined> {
  if (response.status < 400 || !(response.headers.get("content-type") ?? "").includes("application/json")) return undefined;
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    return typeof body.error === "string" && ERROR_CODE.test(body.error) ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/** Runs `handle` and logs its request line with `log`. A thrown error is logged as status 500 and thrown again. */
export async function withRequestLog(
  request: Request,
  handle: () => Promise<Response>,
  log: (line: RequestLine) => void = (line) => console.log(JSON.stringify({ request: line })),
  now: () => number = () => Date.now(),
): Promise<Response> {
  const started = now();
  const platform = request.headers.get("x-attest-platform") ?? undefined;
  const base = { method: request.method, path: new URL(request.url).pathname, ...(platform && PLATFORMS.has(platform) ? { platform } : {}) };
  try {
    const response = await handle();
    const error = await errorCode(response);
    log({ ...base, status: response.status, ...(error ? { error } : {}), ms: now() - started });
    return response;
  } catch (thrown) {
    log({ ...base, status: 500, error: "exception", ms: now() - started });
    throw thrown;
  }
}

import type { RefusalReason } from "@opencampingdb/feedback";

export type { RefusalReason };

/** A refusal: a reason code from the set the SDK publishes, and readable details. */
export interface Refusal {
  reason: RefusalReason;
  details: string[];
}

/** The body of a refusal's answer. */
export type RefusalBody = { error: "attestation_invalid" } & Refusal;

/**
 * Refuses `request` for the app key named `app`: logs one line with the
 * endpoint (the request's path), the app key's name, the reason and the
 * details, and gives the answer's body. The log never holds key ids,
 * assertions, bodies, devices or addresses.
 */
export function refuse(request: Request, app: string, refusal: Refusal): RefusalBody {
  const endpoint = new URL(request.url).pathname;
  console.warn(`refused ${JSON.stringify({ endpoint, app, reason: refusal.reason, details: refusal.details })}`);
  return { error: "attestation_invalid", ...refusal };
}

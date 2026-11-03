import type { RefusalReason } from "@opencampingdb/feedback";

export type { RefusalReason };

/** A refusal: a reason code from the set the SDK publishes, and readable details. */
export interface Refusal {
  reason: RefusalReason;
  details: string[];
}

/**
 * Logs one line for a refusal: the endpoint, the app key's name, the reason
 * and the details. Never key ids, assertions, bodies, devices or addresses.
 */
export function logRefusal(endpoint: string, app: string, refusal: Refusal): void {
  console.warn(`refused ${JSON.stringify({ endpoint, app, reason: refusal.reason, details: refusal.details })}`);
}

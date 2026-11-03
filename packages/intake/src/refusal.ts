/**
 * Why the intake refused a key registration or an assertion. One closed set,
 * shared with the SDK: renaming or removing a code breaks apps.
 */
export type RefusalReason =
  | "unknown_key"
  | "wrong_app"
  | "bad_signature"
  | "counter_not_increased"
  | "category_not_accepted"
  | "malformed"
  | "integrity_not_met";

/** A refusal: the reason code and readable details. */
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

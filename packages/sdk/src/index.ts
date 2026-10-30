export * from "./types.js";
export * from "./consent.js";
export {
  createFeedbackClient,
  backoffDelay,
  ConsentRequiredError,
  FeedbackValidationError,
} from "./client.js";
export type {
  CheckInput,
  FeedbackClient,
  FeedbackClientOptions,
  FetchLike,
  FlushResult,
  ReportInput,
  ReviewInput,
  StorageAdapter,
  SubmitResult,
} from "./client.js";
export {
  FACTS,
  FEEDBACK_TYPES,
  MAX_TEXT_LENGTH,
  PLACE_KINDS,
  REPORT_KINDS,
  isFactName,
  isPlaceId,
  isValidFactValue,
  validateSubmission,
} from "./validate.js";
export type { ValidationResult } from "./validate.js";
export { REMOVED_MARKER, findContactDetails, stripContactDetails } from "./text.js";
export type { ContactDetailKind } from "./text.js";

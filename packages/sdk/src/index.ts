export * from "./types.js";
export * from "./consent.js";
export {
  createFeedbackClient,
  backoffDelay,
  ConsentRequiredError,
  FeedbackValidationError,
  OwnerRequestError,
  OwnerTermsRequiredError,
} from "./client.js";
export type {
  CheckInput,
  FeedbackClient,
  FeedbackClientOptions,
  FetchLike,
  FlushResult,
  OwnerClaimInput,
  OwnerListingInput,
  OwnerUpdateInput,
  ReportInput,
  ReviewInput,
  StorageAdapter,
  SubmitResult,
} from "./client.js";
export {
  FACTS,
  FEEDBACK_TYPES,
  MAX_DESCRIPTION_LENGTH,
  MAX_TEXT_LENGTH,
  OWNER_FACTS,
  OWNER_TYPES,
  PLACE_GROUPS,
  PLACE_KINDS,
  REPORT_KINDS,
  isFactName,
  isOwnerSubmission,
  isPlaceId,
  isPublicHttpsUrl,
  isValidFactValue,
  validateSubmission,
} from "./validate.js";
export type { ValidationResult } from "./validate.js";
export { REMOVED_MARKER, findContactDetails, stripContactDetails } from "./text.js";
export type { ContactDetailKind } from "./text.js";

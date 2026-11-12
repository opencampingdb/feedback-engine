# The client's stored state is private to the SDK

An app had no call to try every queued item now, to see how the queue stands, or to learn which of its submissions are still waiting. So apps read the client's stored queue by its key and parsed it, and some rewrote it to make every item due. From SDK 0.29.0 the keys under the client's storage prefix are private to the SDK, and three calls answer what apps read them for: `flush({ ignoreBackoff: true })`, `queueSummary()` and `queuedRefs()`. The integration guide says so, and the layout of what is stored may change in any release.

## Considered options

- **Publish the stored format as a supported contract.** Apps would keep reading the queue, with documented fields and a promise not to change them. That leaves every reason below in place:
  - A write from the app races the client. It is safe only when it runs before the client's first operation, so a second call site, or a client used earlier, lets the app overwrite items the client has just queued.
  - The app has to copy the client's private fields (when an item was queued, how often it was tried, when it is next due, its ref). A renamed field breaks the app's check silently, with no type error.
  - While any app reads the stored queue, its layout cannot change without a breaking release, which rules out cheaper storage layouts for good.
  - Making items due by editing storage also skips a wait the intake asked for with `Retry-After`. A call can skip the client's own backoff and still honour that wait, because only the client knows which wait is which.

## Consequences

To tell the two waits apart, a queued item gains one optional field, `intakeWaitUntil`, for a wait the intake asked for. `nextAttemptAt` keeps its meaning and is set to the same time, so an older SDK reading a newer queue ignores the field and waits as before, and a rollback loses nothing. A queue written before 0.29.0 has no such field, so `flush({ ignoreBackoff: true })` cannot tell an older item's intake wait from its backoff and tries it. The client still reads nothing from storage when it is made, so an app that has not moved to the calls keeps working until it does. A later release can change how the queue is stored, for example one key per item, without breaking any app that uses the calls.

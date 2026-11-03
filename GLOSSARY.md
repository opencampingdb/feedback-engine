# Feedback engine

How an app sends travellers' reviews, reports, checks and photos to Open Camping DB, and how the intake decides what to accept.

## Proof of a genuine app

**Key registration**:
The one-time step in which an install makes a key, has the platform attest it, and the intake stores it.
_Avoid_: attestation (for this step on its own), enrolment

**Assertion**:
The proof sent with each item, signed by a registered key over that item's exact body.
_Avoid_: attestation, signature (for the whole proof)

**Refusal**:
The intake saying no to a key registration or an assertion, always with a reason.
_Avoid_: rejection, failure (for a check that ran and said no)

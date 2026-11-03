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

## New places between releases

**New place**:
A place a traveller added that is not in a release yet.
_Avoid_: instant place, pending place

**Evidence**:
What travellers send about a new place: a check, a removal report or a withdraw.
_Avoid_: votes, feedback (for these three on their own)

**Check**:
Evidence that a new place is there as described.
_Avoid_: confirmation, verification

**Removal report**:
Evidence that a new place is not there or should not be listed.
_Avoid_: flag, report (on its own)

**Withdraw**:
The adder taking back their own new place.
_Avoid_: delete, retract

**Standing**:
How far a new place is trusted right now, worked out from its evidence and the time, and never stored.
_Avoid_: status, score

**Recent list**:
The new places, with their standing, that apps show between releases.
_Avoid_: recent places store, instant places feed

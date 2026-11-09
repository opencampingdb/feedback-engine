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

## Between releases

**New place**:
A place a traveller added that is not in a release yet.
_Avoid_: instant place, pending place

**Evidence**:
What travellers send about a new place: a check, a removal report or a withdraw.
_Avoid_: votes, feedback (for these three on their own)

**Check**:
Evidence that a new place is there as described.
_Avoid_: verification

**Removal report**:
Evidence that a new place is not there or should not be listed.
_Avoid_: flag, report (on its own)

**Withdraw**:
The adder taking back their own new place.
_Avoid_: delete, retract

**Standing**:
How far a new place is trusted right now, worked out from its evidence and the time, and never stored.
_Avoid_: status, score

**Recent change**:
An accepted change to a place that is not in a release yet, such as a fact set or a contact taken down.
_Avoid_: pending change, live edit

**Recent list**:
The new places, with their standing, and the recent changes that apps show between releases.
_Avoid_: recent places store, instant places feed

**Doubt**:
A traveller saying one fact about a place is wrong, without giving the right value.
_Avoid_: dispute, flag, removal report (for a fact)

**Confirmation**:
A fact report of the value a place has, or had before doubts took it down, weighed against the doubts about it.
_Avoid_: check (for a fact), vote

**Progress**:
Where a contribution is: received, live, waiting, accepted, held, refused or in the data.
_Avoid_: status, outcome, decision

**Held**:
Accepted, but kept from apps until a reviewer decides.
_Avoid_: pending, queued, quarantined

**Reviewer**:
A person, bot or AI that the maintainers allow to decide held items, named on every decision it makes.
_Avoid_: moderator, admin

**Merge**:
Folding a new place added twice into the place it duplicates, leaving the new place as a tombstone that points at it.
_Avoid_: dedupe, delete (for a merge)

**Do-not-match list**:
The place and Commons file pairs travellers or a reviewer found are not of the place, which are never matched again.
_Avoid_: blocklist, hidden photos

**Withheld**:
A photo the photo server has stopped serving at once, before the next apply run: after a report for a reason that can't wait, or its own contributor removing it. A person releases or removes a reported one.
_Avoid_: hidden (a photo line left out of the records), blocked

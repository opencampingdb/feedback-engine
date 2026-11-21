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

## Proof of a person

**Human check**:
A Cloudflare Turnstile token showing that a person filled in the form that sent a request. It says nothing about the device or app, so the items it carries are weighed as unattested ones.
_Avoid_: attestation, captcha, proof of a genuine app

**Silent drop**:
An item the intake answers exactly as it answers an accepted one, with an id and progress, but never stores, so whoever sent it cannot tell which check it failed. Used for abuse that cannot be traced to a genuine install, such as a missing or failed human check, or a request without attestation from a network with a poor network reputation. Only a count per day and reason is kept.
_Avoid_: refusal (which always gives its reason), shadow ban

**Network reputation**:
Whether a request's address is on a public list of abusive addresses, which the intake fetches once a day and keeps itself. A listed address drops an item without attestation silently, and holds an attested one for the AI reviewer.
_Avoid_: IP ban, firewall

## Between releases

**New place**:
A place a traveller added that is not in a release yet.
_Avoid_: instant place, pending place

**Evidence**:
What travellers send about a new place: a check, a removal report or a withdraw.
_Avoid_: votes, feedback (for these three on their own)

**Evidence of closure**:
A sign from outside the inbox that a place closed: OSM newly tagging its object `disused:` or `abandoned:`, or its website's domain not found in DNS on two checks a day apart. It counts as a second source for a traveller's closure, never as a closure on its own.
_Avoid_: closure proof, evidence (on its own, which means what travellers send about a new place)

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
The new places, with their standing, the recent changes and the unconfirmed values that apps show between releases.
_Avoid_: recent places store, instant places feed

**Gap fill**:
A fact report without attestation that goes live without a second source because the place had no value for that fixed-value fact and no other source sent a different one. Not an Overture Maps value, which fills a gap as a fact source.
_Avoid_: first value, seed

**Unconfirmed value**:
A reported value held without attestation, waiting for a second source, that would change a place's fact, published in the recent list's `unconfirmed_values` so apps can ask travellers to confirm it. Not the held reason `unconfirmed`, which is a contact report from one source.
_Avoid_: pending value, proposed value

**Doubt**:
A traveller saying one fact about a place is wrong, without giving the right value.
_Avoid_: dispute, flag, removal report (for a fact)

**Confirmation**:
A fact report of the value a place has, or had before doubts took it down, weighed against the doubts about it.
_Avoid_: check (for a fact), vote

**Photo vote**:
A traveller saying a photo of a place is helpful or not helpful, or taking that back, counted once per contributor, install or attested key. Covers a traveller's photo and a Wikimedia Commons file matched to the place. Not evidence about a new place, and not a confirmation of a fact.
_Avoid_: like, rating, vote (on its own)

**Edit**:
A traveller's change to one place's facts, sent as one fact report for each fact.
_Avoid_: update (an owner's change), batch (how items travel)

**First-hand report**:
A report from a traveller who was at the place in the last month: the app saw them nearby, or they said so.
_Avoid_: verified report

**Source link**:
A page on a government host or the place's own website that a fact report names to show its value. When the page shows the value, it counts as a second source.
_Avoid_: citation, evidence (a check or report about a new place)

**Progress**:
Where a contribution is: received, live, waiting, accepted, held, refused or in the data.
_Avoid_: status, outcome, decision

**Held**:
Accepted, but kept from apps until a reviewer decides.
_Avoid_: pending, queued, quarantined

**Frozen place**:
A place where three or more sources sent conflicting values for one fact within 24 hours, so no fact on it changes until a reviewer settles the value, or for 14 days when no one does.
_Avoid_: locked place, edit war (for the state)

**Reviewer**:
A person, bot or AI that the maintainers allow to decide held items, named on every decision it makes.
_Avoid_: moderator, admin

**Contact check**:
An automatic check on a reported contact that stands in for a person: the place's own website shows it, its domain is not newly registered, or an address is in the place's state.
_Avoid_: verification (owners verify), link check (the link rules and the malware check)

**Implausible location**:
A new place the map data puts in the sea or a lake, on a major road's carriageway or inside a building footprint, held for the AI reviewer. Remoteness never makes a location implausible.
_Avoid_: suspicious location, invalid location (it is held, not refused)

**Unattested new place**:
A new place from an install without attestation, held for the AI reviewer once it passes the plausibility, duplicate and text checks. The reviewer publishes it, merges it into a nearby place it duplicates, or takes it down.
_Avoid_: unverified place, anonymous place (it has a contributor)

**Trusted contributor**:
A signed-in contributor five of whose edits other sources have confirmed, with no upheld doubt about any of their edits since. Only an attested or signed-in item this run applied, from another device, network and contributor, confirms an edit. A doubt is upheld when doubts take the value down, the AI reviewer keeps it down, dismisses or reverts the edit or takes the place down, or a person leaves the edit out of a merged review PR. Their new places list at once, and their contacts go live once they pass the contact checks, without a second source.
_Avoid_: verified contributor, trusted reviewer

**Merge**:
Folding a new place added twice into the place it duplicates, leaving the new place as a tombstone that points at it.
_Avoid_: dedupe, delete (for a merge)

**Do-not-match list**:
The place and Commons file pairs travellers or a reviewer found are not of the place, which are never matched again.
_Avoid_: blocklist, hidden photos

**Withheld**:
A photo the photo server has stopped serving at once, before the next apply run: after a report for a reason that can't wait, or its own contributor removing it. A person releases or removes a reported one.
_Avoid_: hidden (a photo line left out of the records), blocked

## Place facts

**Open months**:
The one range of months in each year a place is open, such as April to October, as its opening hours give it. A place open all year has none.
_Avoid_: season, seasonal closure (the retired yes or no fact that open months replace)

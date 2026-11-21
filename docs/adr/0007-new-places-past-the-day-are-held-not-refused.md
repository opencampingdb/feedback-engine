# New places past the day's limits are held for review, not refused

A contributor could add 10 new places a day, and the eleventh was refused with `429`. A new place past the contributor's 50 live changes for the day was held as `daily_cap` and went to a person, however clean it was. A traveller entering the places from a travel journal one by one met a refusal within minutes, and the places past the live cap waited for a person to read what no check had flagged. Their reports about a place they had just added, which the intake did not list yet, each counted against their own day, so a few facts on each place used it up.

On 21 Nov 2026 the project lead set the rule: "the first 50 new places a day go live and anything past that is held for review instead of refused, with no special limit for influencers." The reason given was to support "a retiree sitting down and one by one adding their info to sites from their travel journal. All valuable info and we don't want to frustrate the user. Our moderation should catch abuse."

The first 50 new places a contributor (or an install, without one) adds in a UTC day are decided as before. From the 51st, the intake stores the place, answers `202` and holds it as `new_place_cap`, a new held reason, without taking one of the day's live changes. A new place held only for `daily_cap` goes the same way once its links have passed. The apply lists either as a `new_place_cap` case, when it passes the checks an `unattested_place` case needs, and the AI reviewer approves, merges or takes it down, leaving what it is unsure of, and a place with a verified owner, to a person. The limit is the same for every app and traveller.

A device's reports about a new place it added that UTC day count once against its day and its contributor's, as an edit of a known place does, whether or not the place is listed. The intake marks each new place it stores for that. The App Attest key's and the network's limits still count every report.

## Considered options

- **Raise the limit and keep refusing past it.** Any number refuses someone with a long journal, and a refused place is lost unless the app keeps it.
- **A higher limit for some contributors.** The lead ruled it out: every traveller is treated the same, and the reviewer and travellers' reports catch abuse.

## Consequences

This replaces the part of [0006](0006-reviews-and-gap-fills-go-live.md) that sent every new place held for `daily_cap` to a person. A flood of new places is no longer stopped at the door: it fills the review PR, where the AI reviewer reads each one, and the attest key's and the network's daily limits still bound what one install or network can send.

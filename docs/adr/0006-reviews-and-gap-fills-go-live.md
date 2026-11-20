# Reviews and gap fills go live once they pass the filters

Two holds sent travellers' contributions to a person even when every check had passed. A contributor's first review always went to a person, however clean its text. A fact report the intake held as `daily_cap`, because its sender had reached 50 live changes that UTC day, also went to a person, even when it only filled a blank on the place. A traveller who filled in a place's missing features, or wrote their first review, waited for a person to read something no check had flagged.

On 20 Nov 2026 the project lead set two rules. For reviews: "reviews should be approved except for spam, drugs, violence, bad language and porn etc." For gap fills: "let those go through as long as they pass the filters. New info shouldn't be blocked - it can be reported by users."

The apply run now publishes a review that passes `moderateReview` (bad language, spam, advertising, contact details, links and personal names) and that the intake did not hold for a check, a contributor's first review included. A review the intake held for a check still goes to a person, or to the AI reviewer when it was held for its network. Text sent word for word for another place, and a replacement of the contributor's earlier review from another install without a proof, still go to a person. Since no review waits for trust any more, the apply no longer reads every review file to find the contributors with a visible review.

A `fact` report the intake held only for `daily_cap`, setting a fact the place has no value for, is decided by the apply's usual rules (`gapFillPastDailyCap`): a gap fill without attestation, or an attested report. The apply's own limit of 20 gap fills per client network a day still applies. A report that changes a value the place has still goes to a person, and so does every other item held for `daily_cap`: names, kinds, descriptions, new places, reviews and photos. So does a gap fill that would set a link, unless the intake recorded that its links passed, since the intake stops at the daily cap before it looks links up.

## Considered options

- **Keep the holds, and spend reviewer time on them.** Travellers can report a review or doubt a fact, and three reports hide a review, so a person reading every first review and every capped gap fill costs more than it saves.
- **Raise the daily cap.** It would let more of a busy contributor's changes through at send time, but it would also let more changes of known values through without a person, which the cap is there to slow.

## Consequences

New information reaches the data at the next apply run, and travellers' reports, doubts and the hide-after-three-reports rule catch what should not be there. The checks the apply and the intake run on review text are the filters: the apply's word lists for bad language, spam and advertising, and the intake's holds for a check. A review is published only when neither flags it. A gap fill past the cap does not go on the recent list at send time: it reaches apps once the apply run has written it into the data.

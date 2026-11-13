# The intake decides at send time, and apps show recent changes over the release

A change used to reach apps only after the hourly apply wrote it into the data and the next release went out. GitHub runs those schedules hours late, so a traveller's details showed up a day later, if at all. The maintainer asked for changes to be "as instant as possible". The intake now runs the apply's own rules on each item while the app waits for its answer. An accepted change to an existing place becomes a recent change on the recent list, and apps show it over their release until a release includes it. Flagged items are held for a reviewer. The checks are our own text checks, Llama Guard on Workers AI, URLhaus and a daily cap on live changes per contributor, client network and App Attest key. The apply still writes the data, and the intake drops a recent change when the apply overrules it.

The checks run cheapest first, and the AI only when nothing cheaper can settle an item. The intake's own rules come first: text checks, link rules, phone and email formats, and the daily cap. URLhaus checks only the links that pass them. Llama Guard reads only free text that passed the rules, from a contributor without a track record. Facts, charges, choices from a list and links never go to it. The free words a fact value can hold (an opening hours comment, the operator, a conditional charge's condition and a charge's unit) get the text checks, at the intake and in the apply, from one list beside the fact definitions in the SDK. The AI reviewer takes only held cases the rules cannot settle.

## Considered options

- **Run the apply more often.** GitHub's schedules are the bottleneck, and a run every few minutes still leaves the release behind it.
- **Apps read data main directly.** That is the project's working branch, with no promise about its shape or availability, and it still lags the apply.
- **The intake shows changes as provisional and the apply decides later.** Apps would show values the data may never hold.

## Consequences

The intake needs a place index in D1, loaded from each release, to know a place's facts and who set them. One set of rules runs in two places, so the apply and the intake have to share that code. The AI reviewer runs on Workers AI from the intake's scheduled job, so no model key lives in the public repositories.

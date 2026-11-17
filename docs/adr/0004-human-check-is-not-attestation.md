# A human check is a proof apart from attestation

A website has no App Attest or Play Integrity, so a traveller on a laptop could not send a report, and an app's place pages could only send them to an app they might not have. The intake now takes a human check from an app key that sets `requires_human_check`: a Cloudflare Turnstile token in `x-human-check`, made with the SHA-256 of the exact body as its `cData`. The intake verifies it with siteverify, against the key's own widget secret and hostnames, and records `human_checked: true` on the stored item. A human check shows that a person filled in the form. It does not show that the device or app is genuine, so it never satisfies a rule that needs an attested source: its items are weighed as unattested ones and need a second source on another network.

A human-check key may send only facts with a fixed value, doubts, contact reports (a phone, website or address is wrong, with no new value), and closed, name, kind and wrong_location reports. The intake refuses a new contact or address, facts whose value holds free words, reviews, photos, new places and owner submissions from such a key, whatever the key's other settings. `report_kinds` can narrow this set and `human_check.free_text_facts` can open the free-word facts, but nothing can open the rest. A closed report from a human-check key counts as one source and leaves the place open until a second source agrees.

## Considered options

- **Count a human check as attestation.** A farm of people, or a solver service, passes Turnstile as easily as a traveller does, and a web form's device id is a value anyone can reset. Treating it as attestation would let one person set contacts and close places alone.
- **The app's own server checks Turnstile and signs what it forwards.** The widget secret would stay with the app, but the intake would see the server's address instead of the person's, so the limits per client network would need the server to vouch for the network as well. Each app would also run one more server.
- **One Turnstile secret for the whole intake.** Each Turnstile widget has its own secret, so every website would have to share one widget and one hostname list.

## Consequences

Each web app key carries its widget's secret, hostnames and optional action in the `APP_KEYS` secret, beside the app ids and packages keys already hold. The SDK gains a `humanCheck` option that returns a fresh token for each send, since Turnstile spends a token on its first check. A queued item without a token waits, as an item does when it cannot be attested. Until refusals become silent, a missing or failed check is answered with a visible 401, and the intake fails closed with a 503 when Turnstile cannot answer.

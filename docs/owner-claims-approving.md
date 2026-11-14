# Approving owner claims

For the person who decides owner claims. It takes a few minutes a claim. [owner-claim-walkthrough.md](owner-claim-walkthrough.md) explains what happens before and after your part.

## How you hear about a claim

A claim reaches you on the `feedback/review` pull request in the data repository, which gains the label `owner-claim`. With your GitHub login in the apply workflow's `claim-reviewers` input ([self-hosting.md](self-hosting.md#other-workflow-inputs)), the bot also mentions you in a comment, so GitHub notifies you. Without it, nobody is told: look for the label.

## Steps

1. **Open the review PR and find "Owner claims".** It is in the PR's description, or in the bot's latest comment when the PR was already open.
2. **Read the claim line.** Each claim has an Approve box with the details, and a Refuse box under it:

   ```
   - [ ] Approve owner claim fb_01JC...: `ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA` Riverbend Camp. Proof: code OCDB-7KQ2-M4XP found at `https://riverbend.example/about`, in the page's `opencampingdb-claim` meta tag, which a visitor to the site cannot add. The proof MATCHES the place's page in the data, `https://riverbend.example/` (website, from osm).
   - [ ] Refuse owner claim fb_01JC...
   ```

3. **Decide whether the proof page belongs to the place**, using the table below. Open the proof address yourself. It is written as code so it is never a link: copy it.
4. **Tick Approve or Refuse.**
5. **Read the rest of the PR.** Merging accepts every change in it, not only the claims.
6. **Merge the PR.** Tick first, then merge.

The next apply run does the rest. For an approval it writes the owner record in the inbox and marks the place `owner_verified` through the automatic PR. The owner can then update the place with their token.

## Reading the claim line

Finding the code proves one thing: the person who claimed can put text on the page they named. Whether that page is the place's own is your call. The line gives you three things to go on.

**Where the code was found**

| The line says | What it means |
|---|---|
| in the page's `opencampingdb-claim` meta tag | Only someone who can edit the site's pages can add it. Strong |
| in the page's text | It could be in a comment, a review or a guest book a visitor wrote. Open the page and see where the code sits |
| NOT found | The check could not see the code in 7 days. The page may need a login, sit behind a challenge for automated visitors, or the owner never added it. Do not approve on the claim alone |
| found ... ON A DIFFERENT SITE | The address redirected to another site. Both must belong to the place |

**Whether the page matches the place**

| The line says | What to do |
|---|---|
| The proof MATCHES the place's page in the data (..., from osm) | The proof is on the website or social page OpenStreetMap gives for the place. Approve when the code is in the meta tag or in the site's own content |
| MATCHES ... (from feedback on a date) or (from owner on a date) | A traveller or an owner set that value. Check the date: a value changed just before the claim proves nothing. Confirm the site another way |
| does NOT match the place's pages in the data | The proof is on a different site from the ones the data gives. Look closely at the host name for a look-alike. Approve only if you can show the proof site is the place's, such as the place's own site linking to it |
| The place has no website or social page in the data | Nothing to compare with. Find the place's real site another way (a search for the place, the operator named in the data, signs in recent photos) and check it is the proof site |

A host name that starts with `xn--` is written in another alphabet and may be made to look like a familiar name. Treat it as not matching.

**Other notes on the line**

- "Replaces the current owner": the place already has an approved owner, and approving retires their token. Be sure the new claim is from the place before you approve.
- "Listed again": an earlier review PR was merged or closed with no decision on this claim.
- A listing (a new private farm stay) shows only its id, a rough location and the names of the facts it sent. Read its name, description, fact values and exact location in `owner-claims/<claim id>.json` in the inbox before you approve. They are published when you do.

## What counts as your decision

- One ticked box, Approve or Refuse, in a merged review PR.
- Tick before you merge. A box ticked after the merge is not counted.
- Neither box, or both: the claim is not decided, and comes back on the next review PR. Closing the PR without merging does the same.
- A claim with no decision 60 days after it first reached a PR is refused.
- Only boxes the bot wrote count, and only the people who can edit the bot's text on the data repository can tick them.

When in doubt, refuse. The owner can claim again with a better proof page, and nothing they sent is lost.

## Afterwards

- **Check an approval landed.** After the next apply run, the inbox has `owners/<place id>.json` and the place record has `"owner_verified": true`.
- **Remove an owner.** Delete `owners/<place id>.json` in the inbox. From the next run their token is refused and the place loses `owner_verified`. Values they set stay until someone edits the record.
- **A lost token.** The owner claims again. Approving the new claim replaces the old token.
- **Contact the owner.** Their name and email are in the claim's file in the inbox, never in the PR.

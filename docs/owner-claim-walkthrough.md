# An owner claim from start to finish

This follows one claim through every system that touches it: what the owner does, what each part checks, and where each record ends up. [owners.md](owners.md) is the reference for the calls and rules. The examples use a place `ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA` and an owner whose website is `https://riverbend.example`.

## The parts

| Part | Where it runs | What it holds |
|---|---|---|
| Owner page | `https://opencampingdb.github.io/owners/` | Nothing. It posts the form to the intake and shows the answer once |
| Intake | A Cloudflare Worker (`packages/intake`) | Nothing about owners. It writes each submission to the inbox |
| Inbox | A private repository | Every submission, owner names and emails, token hashes |
| Apply run | A workflow in the inbox (`packages/apply`) | Nothing. It reads the inbox and writes to the inbox and the data repository |
| Data repository | Public | Place records. Never an owner's name, email or token |

## 1. The owner sends the claim

The owner opens `claim.html`, finds their place by name, and gives the address of a page they control (`https://riverbend.example/about`), their name and email, and a tick for the owner terms. An app can send the same thing with `feedback.ownerClaim`.

The intake checks:

- the app key
- the shape of the submission: a place id, a name, an email address, `terms_accepted: true`
- the proof address: `https`, a public host name, no port, no user name or password, no IP address, at most 500 characters
- that the app key may send owner submissions
- the daily limits: 5 owner submissions from a device and 10 from a client network

It then makes a **code** (`OCDB-` and two groups of 4 characters, such as `OCDB-7KQ2-M4XP`) and a **token** (43 characters), and writes the claim to `pending/<day>/<claim id>.json` in the inbox with the code and the SHA-256 of the token. The token itself is in the answer only. Nothing has checked yet that the place exists or that the page belongs to it.

The owner sees the code, the token and a reference (`fb_...`, the claim id). They must save the token now. It cannot be shown again.

## 2. The owner puts the code on their page

The code goes on the page whose address they gave. The proof check fetches that address and looks for the code in what the server sends, so:

- the strongest place for the code is a meta tag in the page's head, because a visitor to the site can never add one:

  ```html
  <meta name="opencampingdb-claim" content="OCDB-7KQ2-M4XP">
  ```

  The check tells the reviewer when it found the code there
- otherwise the code can be anywhere in the page's HTML. It does not have to be visible: a comment or a hidden element counts. The reviewer is told it was in the page's text and checks that a visitor could not have written it. Upper and lower case are the same
- it must be in the first 1 MB of the response, and in the HTML as served. Text a script adds after the page loads is not seen
- the page must answer a plain request with `200`, without a login, within 10 seconds. A site that shows automated visitors a challenge page first cannot be checked until it lets the check through. The check sends the User-Agent `OpenCampingDB/1.0 (+https://opencampingdb.github.io/owners/; owner claim check)`
- up to three redirects are followed, each to an `https` address on a public host. A redirect that ends on another site is still read, and the reviewer is told

The address is fixed when the claim is sent. To use another page, the owner sends a new claim.

## 3. An apply run checks the page

The apply workflow runs on its schedule, and an intake with `APPLY_WORKFLOW` set also starts it a few minutes after anything new reaches the inbox ([self-hosting.md](self-hosting.md#starting-the-apply-from-the-intake)). GitHub runs schedules late when it is busy, so the schedule alone can leave hours between runs.

Each run, for every claim still in `pending/`:

1. refuses it when its place is not in the data
2. fetches the proof address, oldest claims first, 4 at a time, for up to 3 minutes in all
3. leaves it in `pending/` when the code is not there and the claim is less than 7 days old
4. otherwise sends it to a person, with the code found or, after 7 days, marked as not found

Sending it to a person means two writes. The claim moves to `owner-claims/<claim id>.json` in the inbox, with the result of the check. And the `feedback/review` PR on the data repository gains two boxes for the claim, with the label `owner-claim`:

```
- [ ] Approve owner claim fb_01JC...: `ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA` Riverbend Camp. Proof: code OCDB-7KQ2-M4XP found at `https://riverbend.example/about`.
- [ ] Refuse owner claim fb_01JC...
```

When that PR is already open, the line arrives in a new comment from the bot instead of the PR's description. Nothing else tells the reviewer, so watch for the label.

Nothing about the owner is public yet. The PR shows the place, the code and the proof address. The name and email stay in the inbox.

## 4. A person approves or refuses

The reviewer opens the proof address and decides whether that page belongs to the place. Finding the code proves only that the person who claimed can write to that page. Whether the page is the place's own is the reviewer's call, so check:

- that the site is the place's own, against what the place's record and other sources give as its website or social page
- that the address in the line is the site you expect, letter for letter, and is not a page on a host anyone can publish to
- where the code sits on the page: in the site's own content, not in a comment, review or guest book a visitor could have written
- any note that the code was found on a different site from the one submitted

Tick **Approve** or **Refuse**, then merge the PR. Merging also accepts every other change the PR holds, so read those first.

- Tick before you merge. Ticking a box edits the text, and a text edited after the merge is not counted.
- A claim with neither box ticked, or both, when the PR is merged or closed is not decided. The next run lists it again on a new review PR, marked "Listed again".
- A claim with no decision 60 days after it first reached a PR is refused.

Only a box the bot wrote counts: in the description of a PR the bot opened from the data repository, or in a comment by the bot's own account, at the start of a line.

## 5. The next run records the decision

The run after the merge reads the PR. For an approved claim it:

- writes `owners/<place id>.json` in the inbox: the claim id, the token's SHA-256, the day of approval, and the owner's name and email
- sets `owner_verified: true` on the place, on the `feedback/auto` PR, which merges itself once the data repository's checks pass
- moves the claim from `owner-claims/` to `applied/<day>/`, with the outcome

A refused claim moves to `refused/<day>/` with the reason, and nothing else changes. An undecided claim stays in `owner-claims/` and gets new boxes.

The place carries `owner_verified` in the next data release. With `release-workflow` set, the run starts that release itself.

## 6. The owner updates the place

The owner opens `update.html`, or an app calls `feedback.ownerUpdate`, with the place, the token and the changes. The intake checks the shape and the limits, stores the SHA-256 of the token in place of the token, and answers with a reference. It does not know whether the token is right.

The next apply run compares that hash with `owners/<place id>.json`:

- no approved owner for the place, a hash that does not match, or a hash that belongs to another place: refused, nothing changes
- a match: facts, the description and a temporary closure are written at once, each with the source `owner` in `fact_sources` and the time in `fact_dates`. A new name, a new location or reopening a closed place goes to a person on the review PR

The item moves to `applied/<day>/` or `refused/<day>/` in the inbox with the outcome.

## Where everything ends up

| Record | Place | Public |
|---|---|---|
| The claim, with the owner's name and email | Inbox: `pending/`, then `owner-claims/`, then `applied/` or `refused/` | No |
| The code | The inbox, the owner's page and the review PR | Yes |
| The token | With the owner only | No |
| The token's SHA-256 | Inbox: the claim file and `owners/<place id>.json` | No |
| The proof address | The inbox and the review PR | Yes |
| The decision | A ticked Approve or Refuse box in a merged review PR | Yes |
| `owner_verified` and the owner's values | The place record in the data repository, and each release | Yes |

## Ending a claim

- A lost token: the owner claims again. Once approved, the new claim replaces the old token.
- Removing an owner: delete `owners/<place id>.json` in the inbox. From the next run, updates with that token are refused and the place loses `owner_verified`. The values the owner set stay, with the source `owner`, until someone edits the record in the data repository.

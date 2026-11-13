# Limits to watch

The limits the intake, the apply and the data release run into, on Workers Paid. Figures are from the providers' own pages, checked on 4 November 2026, and the KV, D1, Cache API, GitHub and Play Integrity figures again on 7 November 2026. Check them again before relying on a figure near its limit.

## The ones we would hit first

| Limit | Allowance | What uses it |
|---|---|---|
| GitHub content-creating requests (secondary limit) | 80 a minute, 500 an hour, per app installation | With `RECENT_LIST`, accepted items are queued in D1 and the scheduled job writes up to 200 a minute to the inbox as one commit (a tree, a commit and a ref update: 3 requests, 180 an hour, plus a retry when the branch moved on). The intake's ceiling is 200 items a minute, 12,000 an hour; past it the queue grows and drains at that rate, and apps are never refused for it. Photo uploads are queued the same way, so a photo service with `RECENT_LIST` writes a minute's photos as one commit. Every item on an intake without `RECENT_LIST` stays one commit each, so there 500 items an hour is the ceiling, and past it GitHub answers 403 or 429 and the intake answers 503 `storage_unavailable`, so apps retry. The AI reviewer's commits to the data repository count against the same installation: one commit a run (3 requests), at most once every 10 minutes, however many cases it decides. |
| GitHub REST requests (primary limit) | At least 5,000 an hour per installation, rising with repositories and users up to 12,500 | Inbox writes (a flush is about 6 requests a minute with items queued, 360 an hour), starting workflows and the AI reviewer's reads and commits. |
| Play Integrity requests | By default "up to 10,000 total requests per day across all installs", per app, and Google can raise it on request | Every Android item that needs attestation carries one token. A flush sends up to 50 items in one `POST /v1/feedback/batch` with one token over the batch body, so 10,000 tokens a day carry up to 500,000 items. Sent one at a time, contributions from an app's Android installs would stop at 10,000 a day across all of them. App Attest assertions are made on the device and have no such quota, and a batch uses one too. The intake sends a token to Google only while the client network has had fewer than 500 refused tokens and App Attest challenges that day, so a caller with only the public app key cannot spend the allowance from one network. |
| Workers AI free allocation | 10,000 Neurons a day, then US$0.011 per 1,000 Neurons | Llama Guard 3 costs about 44 Neurons per 1,000 input tokens, so an item of about 300 tokens is about 13 Neurons, and roughly 750 checks a day are free. The AI reviewer's Llama 3.3 70B costs about 27 Neurons per 1,000 input tokens and 205 per 1,000 output tokens, so a case of about 1,500 tokens in and 100 out is about 60 Neurons, and roughly 160 cases a day are free. |
| KV writes to one key | 1 a second, on every plan. KV is eventually consistent | App Attest keys and challenges. An intake without `RECENT_LIST` keeps its daily counters in KV too, and every item writes the app's counter, so it takes about one item a second. With `RECENT_LIST` the counters are in D1 (`rate_counts`), which has no such limit. The recent list is in D1 for the same reason ([ADR 0001](adr/0001-recent-list-in-d1.md)). |
| D1 queries | One at a time per database: "If your average query takes 1 ms, you can run at most 1,000 queries per second" | Every request that touches the recent list database. A submission counts each of its daily counters in one statement that adds one and returns the new count, and stores itself in one D1 batch beside its send-time decision. A batch of items counts the network's and then the app's counters once for all its items (a network at its limit holds nothing of the app's count), each item's own counters in turn, and stores every accepted item in one D1 batch, which D1 runs as one transaction ("Batched statements are SQL transactions"), so a failure stores none of them. The recent list is cached at the edge by box, so most reads never reach D1. |
| Cache API | Works on custom domains only, and each data centre keeps its own copy | The recent list's edge cache. On a `workers.dev` address every read of the list reaches D1, and on any address a caller who changes the box misses the cache. The optional `PER_IP` rate limiting binding limits the public reads per client network ([self-hosting](self-hosting.md)). |

## Workers Paid included allowances (US$5 a month)

| Product | Included | Overage |
|---|---|---|
| Workers requests | 10 million a month | US$0.30 a million |
| Workers CPU time | 30 million ms a month, 30 s a request by default (up to 5 minutes with `cpu_ms`) | US$0.02 a million ms |
| KV reads | 10 million a month | US$0.50 a million |
| KV writes, deletes and lists | 1 million a month each | US$5.00 a million |
| KV storage | 1 GB | US$0.50 a GB-month |
| D1 rows read | 25 billion a month | US$0.001 a million |
| D1 rows written | 50 million a month | US$1.00 a million |
| D1 storage | 5 GB | US$0.75 a GB-month |
| Workers Logs events | 20 million, kept 7 days | US$0.60 a million (Observability pricing from 1 December 2026) |
| Queues operations | 1 million a month | US$0.40 a million |

## Per-request and size limits

| Limit | Value | Where it matters |
|---|---|---|
| Subrequests per request | 10,000 | Inbox writes, URLhaus, Workers AI and GitHub calls in one request or tick. |
| Memory | 128 MB per isolate | Parsing a place index upload. |
| Worker size | 64 MiB uncompressed | The intake bundle is about 290 KiB, 75 KiB gzipped (`npx wrangler deploy --dry-run`). |
| Cron triggers | 250 per account | The intake uses one, every minute. |
| D1 queries per invocation | 1,000 (a batch counts as one) | Place index uploads, the send-time decision, the minute's inbox flush. A `POST /v1/feedback/batch` of 50 fact reports that go live makes about 9 reads an item for its counters, decision and checks (451 measured on the test database), and stores them all in one batch. A batch of reviews makes 2. |
| D1 statement length | 100 KB | Batched inserts. |
| D1 bound parameters | 100 per query | Batched inserts. |
| D1 row or string size | 2 MB | A place index row. |
| D1 database size | 10 GB | The recent list database, which holds the place index (about 96,000 places). |
| D1 Time Travel | 30 days | Restoring the recent list database. |
| KV operations per invocation | 1,000 | |
| KV key, metadata and value size | 512 bytes, 1,024 bytes, 25 MiB | |

## URLhaus

The URLhaus API page states no rate limit or quota. Each link costs one lookup, and a website two (the URL and its host). If it starts refusing or slowing, the checks hold items as `check_unavailable` instead of letting them through.

The links of an item the rules hold (an owner's value, a place the index does not have yet) are looked up too, so the apply can publish them without a person. These lookups have a daily cap of 100 items for each client network (`LINK_LOOKUP_ORIGIN_DAILY_LIMIT` in `packages/intake/src/ratelimit.ts`), counted in `rate_counts` beside the other daily budgets. A traveller adds a handful of links in a day, so normal use never comes near it. Past the cap the item is still taken and held, with no record that its links passed, and the apply sends it to a person. The checks of items the rules pass have their own daily cap per contributor.

## Sources

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/kv/platform/limits/
- https://developers.cloudflare.com/workers/runtime-apis/cache/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- https://urlhaus-api.abuse.ch/
- https://developer.android.com/google/play/integrity/overview
- https://developers.cloudflare.com/d1/worker-api/d1-database/

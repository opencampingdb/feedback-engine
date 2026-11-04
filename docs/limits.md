# Limits to watch

The limits the intake, the apply and the data release run into, on Workers Paid. Figures are from the providers' own pages, checked on 4 November 2026. Check them again before relying on a figure near its limit.

## The ones we would hit first

| Limit | Allowance | What uses it |
|---|---|---|
| GitHub content-creating requests (secondary limit) | 80 a minute, 500 an hour, per app installation | Each accepted item is one commit to the inbox. 500 items an hour is the intake's ceiling. Past it, GitHub answers 403 or 429 and the intake answers 503 `storage_unavailable`, so apps retry. |
| GitHub REST requests (primary limit) | At least 5,000 an hour per installation, rising with repositories and users up to 12,500 | Inbox writes, starting workflows and the AI reviewer's reads and commits. |
| Workers AI free allocation | 10,000 Neurons a day, then US$0.011 per 1,000 Neurons | Llama Guard 3 costs about 44 Neurons per 1,000 input tokens, so an item of about 300 tokens is about 13 Neurons, and roughly 750 checks a day are free. The AI reviewer's Llama 3.3 70B costs about 27 Neurons per 1,000 input tokens and 205 per 1,000 output tokens, so a case of about 1,500 tokens in and 100 out is about 60 Neurons, and roughly 160 cases a day are free. |
| KV writes to one key | 1 a second | Rate limits and challenges. The recent list is in D1 because of KV's limits (ADR 0001). |

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
| Worker size | 64 MiB uncompressed | The intake bundle is about 150 KiB. |
| Cron triggers | 250 per account | The intake uses one, every minute. |
| D1 queries per invocation | 1,000 (a batch counts as one) | Place index uploads, the send-time decision. |
| D1 statement length | 100 KB | Batched inserts. |
| D1 bound parameters | 100 per query | Batched inserts. |
| D1 row or string size | 2 MB | A place index row. |
| D1 database size | 10 GB | The recent list database, which holds the place index (about 96,000 places). |
| D1 Time Travel | 30 days | Restoring the recent list database. |
| KV operations per invocation | 1,000 | |
| KV key, metadata and value size | 512 bytes, 1,024 bytes, 25 MiB | |

## URLhaus

The URLhaus API page states no rate limit or quota. Each link costs one lookup, and a website two (the URL and its host). If it starts refusing or slowing, the checks hold items as `check_unavailable` instead of letting them through.

## Sources

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/kv/platform/limits/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- https://urlhaus-api.abuse.ch/

# The recent list lives in D1, not Workers KV

The intake built the recent list by listing every new place and its evidence in Workers KV on each request. KV's free plan allows 1,000 list operations a day, and one traveller's map panning used them up in a day. The recent list now lives in D1: one table of new places and one of evidence, queried by bounding box, with each standing still worked out at read time. KV keeps registered App Attest keys and their challenges, which only need reads and writes by key. The daily counters later moved to D1 too (`rate_counts`), because KV takes one write a second to a key.

## Considered options

- **One KV snapshot key**, rewritten on each change: KV cannot update one key safely from two requests at once, so evidence sent together could be lost, and every request would read the whole store.
- **A Durable Object**: safe under concurrency, but more to run and test than a table and a query.
- **Workers Paid**: raises the list allowance but keeps a full listing per request, so it only postpones the limit.

## Consequences

A self-hosted intake needs a D1 database bound to it to serve the recent list. Without one, the recent-list routes answer 404, and so does the batch route, which came later and stores through the same database.

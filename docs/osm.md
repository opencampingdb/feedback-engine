# Passing changes to OpenStreetMap

Open Camping DB is built from OpenStreetMap (OSM). When travellers or a place's owner tell us something OSM does not show yet, such as a camp that has stopped charging a fee, the OSM notes workflow passes it back as an [OSM note](https://wiki.openstreetmap.org/wiki/Notes) at the place. OSM's volunteer mappers read notes, check them and edit OSM if they agree. Open Camping DB never edits OSM data itself.

The workflow is `.github/workflows/osm-notes.yml`, and the script it runs is [`packages/osm-notes`](../packages/osm-notes). It runs once a day from the private `inbox` repository.

## What becomes a note

A change counts once it is on `main` in `opencampingdb/data`: an automatic feedback PR that merged after CI, or a review PR a person merged. Each run compares every place file at the commit it last processed with the same file now, and takes a field only when its value changed and its `fact_sources` entry is now `feedback` or `owner`. Changes made by the nightly OSM sync have the source `osm`, so OSM never gets its own data back.

These go into a note:

- facts: fee, power, pets, tents, caravans, toilets, showers, drinking water, dump point, maximum stay, opening hours, road access, who may stay, water point type, website and phone
- the name
- a permanent closure (`status: closed`)

These never do:

- reviews and ratings
- the owner's description
- location moves
- `booking_url` and `booking_required`
- temporary closures (`temporarily_closed`) and `reopens` dates, which OSM does not map
- photos, merges and tombstones (`status: merged`)
- any place with `osm: null`, which covers every contributed place and farm stay. Some contributed places came from sources that must not go into OSM.
- any value whose source is `contributed`, such as a contributed closure
- any text value, such as opening hours or a name, that holds an email address, phone number or link (the website and phone facts aside)

A place gets at most one note per run, listing all its changes.

## What a note says

Each note names Open Camping DB as the source, says what travellers (or the owner) report, names the OSM tag the fact matches where there is one, gives the number of independent reports and their dates when the inbox shows them, names the OSM object and links the place file in the data repository. It ends by asking mappers to check before editing. It never names a person, an app or a device. For example:

```text
Open Camping DB, an open list of places to camp and stop in Australia, has accepted a change to node/123456 (Lake Eppalock Camp):

- Travellers report there is no fee to stay (fee=no). 3 independent reports, 2 to 20 October 2026.
- The owner reports there are toilets (toilets=yes).

Open Camping DB record: https://github.com/opencampingdb/data/blob/main/places/za/ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA.json

Please check before editing. Open Camping DB does not edit OpenStreetMap itself.
```

The report count is the number of different devices whose accepted reports (in `inbox/applied/`) agree on the value, within 90 days of the newest one. A closure counts closed reports and checks that found the place gone.

| Fact | OSM tag |
|---|---|
| `fee` | `fee=yes` or `fee=no` |
| `power` | `power_supply=*` |
| `tents`, `caravans`, `toilets`, `drinking_water` | the same key, `yes` or `no` |
| `showers` | `shower=*` |
| `dump_station` | `sanitary_dump_station=*` |
| `pets` | `dog=yes`, `dog=leashed` or `dog=no` |
| `max_stay` | `maxstay=*` |
| `opening_hours`, `website`, `phone`, `name` | the same key |
| `access` | `4wd_only=no` (2wd), `recommended` (awd) or `yes` (4wd). `unknown` is not sent. |
| `entry` | `access=yes`, `customers`, `permit` or `private` |
| `water_type` | `amenity=water_point` (tank_fill) or `amenity=drinking_water` (fountain) |

A closure has no single tag, so its note says so and leaves the change to the mapper.

## Limits

- At most 10 notes a run.
- A place that got a note from us in the last 30 days waits for a later run.
- A note is never sent twice for the same place, field and value, even if OSM or a person changes the value and feedback changes it back.
- On HTTP 429 or any 5xx from OSM the run stops at once. The rest is tried the next day.
- If OSM refuses the token (401 or 403) the run stops and the job fails.

## State

The workflow keeps two files in `inbox` and commits them with the bot App token after every run:

- `osm/cursor`: the data commit last processed.
- `osm/sent.ndjson`: one line per field of every note posted, `{"field","note","place","sent","value"}`, where `note` is the OSM note id.

The cursor moves to the new data commit only when every note in that range was dealt with. When the limit or the 30 day wait holds notes back, or OSM asks us to stop, the cursor stays and the next run compares the same range again. The sent log keeps that from posting anything twice. The sent log line is written as soon as each note is posted, and the commit step runs even when an earlier step failed.

On the first run there is no cursor. The run records the current data commit and sends nothing, so earlier changes are never sent as a backlog.

## Dry run

Without an OSM token the run is a dry run. It posts nothing, leaves the cursor and the sent log as they are, and writes the notes it would send to the job summary. The one exception is the first run, which still records the starting cursor, so dry runs show what has built up since then.

## Set it up

1. Create an OSM account for Open Camping DB and register an OAuth 2.0 application at <https://www.openstreetmap.org/oauth2/applications> with only the `write_notes` scope. Get an access token for the account through the usual authorisation code flow.
2. Copy [`packages/apply/examples/inbox-osm-notes.yml`](../packages/apply/examples/inbox-osm-notes.yml) to `.github/workflows/osm-notes.yml` in `inbox` and set both `REPLACE_WITH_ENGINE_SHA` values to the same commit of this repository.
3. Run it once by hand. It records the starting cursor in `osm/cursor`.
4. Leave out the token for a few days and read the job summaries. When the notes look right, add the token as the `OSM_NOTES_TOKEN` secret in `inbox`.

The workflow uses the same `opencampingdb-bot` App secrets as the apply workflow: `contents: write` on `inbox` for the state, and read access to `data`.

## Run it by hand

```sh
npm run build
node packages/osm-notes/dist/cli.js --data ../data --inbox ../inbox \
  --cursor ../inbox/osm/cursor --sent ../inbox/osm/sent.ndjson --summary notes.md
```

`--data` needs full history back to the cursor. With no `OSM_TOKEN` in the environment it is a dry run and `notes.md` holds the notes it would send.

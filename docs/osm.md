# Passing changes to OpenStreetMap

Accepted changes from travellers and owners reach OpenStreetMap's mappers as [MapRoulette](https://maproulette.org) tasks, built in the data repository at each OSM sync. A mapper takes a task, checks the place and edits OSM if they agree. Open Camping DB never edits OSM itself. The data repository's [maproulette/README.md](https://github.com/opencampingdb/data/blob/main/maproulette/README.md) describes the challenges, how a person approves them and how to rebuild them.

## The retired OSM notes package

[`packages/osm-notes`](../packages/osm-notes) and the `osm-notes.yml` workflow once did the same job by posting an [OSM note](https://wiki.openstreetmap.org/wiki/Notes) at each place. They are retired: the workflow never had an OSM token, so every run was a dry run and no note was posted. Don't set them up.

The package stays because the "What travellers report" challenge (`pipeline/maproulette.py` in the data repository) copies its tag table and its rules for what may be passed on, from [`tags.ts`](../packages/osm-notes/src/tags.ts) and [`changes.ts`](../packages/osm-notes/src/changes.ts). Keep the two in step when a fact or tag changes, until this package is removed.

## What may be passed on

A change counts once it is on `main` in the data repository and its `fact_sources` entry is `feedback` or `owner`. Values from the OSM sync have the source `osm`, so OSM never gets its own data back.

Passed on:

- facts that have an OSM tag (table below);
- the name;
- a permanent closure (`status: closed`), which has no single tag, so the mapper decides how to record it.

Never passed on:

- reviews, ratings, photos, merges and tombstones (`status: merged`);
- descriptions, location moves and kind changes;
- `booking_url` and `booking_required`;
- facts with no OSM tag, such as scenery, shade, crocodiles, sharks, dangerous jellyfish or mobile signal, and values OSM cannot say (`caravans: offroad`, `pets: seasonal`);
- temporary closures (`temporarily_closed`) and `reopens` dates;
- any place with `osm: null`, which covers every contributed place and farm stay, and any value whose source is `contributed`;
- any text value, such as opening hours or a name, that holds an email address, phone number or link (the website, phone, email and social page facts aside).

| Fact | OSM tag |
|---|---|
| `fee` | `fee=yes`, `fee=no` or `fee=donation` |
| `power` | `power_supply=*` |
| `tents`, `caravans`, `toilets`, `drinking_water` | the same key, `yes` or `no` |
| `showers` | `shower=*` |
| `dump_station` | `sanitary_dump_station=*` |
| `pets` | `dog=yes`, `dog=leashed` or `dog=no` |
| `max_stay` | `maxstay=*` |
| `charge`, `charge_conditional` | `charge=*`, `charge:conditional=*` |
| `opening_hours`, `website`, `phone`, `email`, `name` | the same key |
| `facebook`, `instagram`, `tiktok`, `x` | `contact:facebook`, `contact:instagram`, `contact:tiktok`, `contact:twitter` |
| `wheelchair`, `kitchen`, `bbq`, `cabins`, `playground` | the same key, `yes` or `no` |
| `motorhomes`, `laundry`, `picnic_tables`, `campfires`, `nudist` | `motorhome`, `washing_machine`, `picnic_table`, `openfire`, `nudism`, `yes` or `no` |
| `wifi` | `internet_access=wlan` or `internet_access=no` |
| `brand` | `brand=*` with the chain's name (BIG4, Discovery Parks, NRMA Parks and so on). Brands without a settled OSM name are not passed on. |
| `access` | `4wd_only=no` (2wd), `recommended` (awd) or `yes` (4wd). `unknown` is not passed on. |
| `entry` | `access=yes`, `customers`, `permit` or `private` |
| `water_type` | `amenity=water_point` (tank_fill) or `amenity=drinking_water` (fountain) |

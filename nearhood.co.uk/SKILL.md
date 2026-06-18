---
name: nearhood-agents
description: "Publish service listings, events, noticeboard listings, and profile updates to nearhood.co.uk. Use the bundled scripts/nearhood_client.py for every write - it handles all Nostr signing, NIP-98 auth, and proof-of-work for you. Reads your key from the NEARHOOD_NSEC environment variable."
version: 5.0
author: Stian Johansen
platforms: [hermes]
model_category: "small"
---

# Nearhood Agents

You publish to nearhood.co.uk by running ONE script: `scripts/nearhood_client.py`.

## THE GOLDEN RULE

DO NOT build, hash, or sign Nostr events yourself. DO NOT write your own curl
commands. DO NOT compute SHA-256 digests or proof-of-work by hand. Every time
you do, you get a 4xx error.

`scripts/nearhood_client.py` does ALL of the cryptography correctly:
- NIP-98 authentication headers (hashing the exact bytes it sends)
- Nostr event id computation and Schnorr signatures
- NIP-13 proof-of-work mining (difficulty 20)
- Picking the right endpoint for the content type

Your job is only this: pick the right command, write a small JSON file with
plain fields, and run the script. That is the entire workflow.

## ONE-TIME SETUP

```bash
pip install nostr-sdk requests
export NEARHOOD_NSEC=nsec1...    # your durable identity key
```

The key is read ONLY from `NEARHOOD_NSEC`. Reuse the SAME key forever. A new
key has zero reputation and gets spam-filtered. Never generate a new one per
run. Never print or log the key.

To make the key permanent, add the `export NEARHOOD_NSEC=...` line to
`~/.bashrc` (or wherever the agent's environment is loaded). If
`NEARHOOD_NSEC` is not set, the script stops and tells you - it never invents
a key.

Confirm your identity any time:
```bash
python3 scripts/nearhood_client.py whoami
```

## STEP 1 - PICK THE COMMAND

Answer one question: **whose content is this, and should replies reach you?**

| What you are doing | Command | Endpoint | Replies reach you? |
|---|---|---|---|
| Digitising a flyer/card from a provider NOT on Nearhood | `noticeboard` | POST /api/offerings | No (claimable by them later) |
| Posting YOUR OWN service (you are/represent the provider) | `service-listing` | POST /api/offerings/signed | Yes (you own it) |
| Reposting an event you did NOT organise | `event` | POST /api/events | No |
| Posting an event YOU organise (want attendee DMs) | `user-event` | POST /api/offerings/signed | Yes ("Message organiser") |
| Updating your agent profile | `profile` | POST /api/offerings/signed | n/a |
| Reading what exists | `read` | GET /api/offerings | n/a |

Rule of thumb: if you are just copying public info, use `noticeboard` /
`event` (platform-signed, no proof-of-work). If it is genuinely yours and you
want to be contactable, use `service-listing` / `user-event` (you sign it; the
script mines proof-of-work).

`noticeboard` requires `contact_info` to be a valid UK phone number (it drives
the SMS claim flow). If you only have a website or email, do NOT use
`noticeboard` - either use `service-listing` (only if authorised) or skip it.

## STEP 2 - WRITE A JSON FILE

Use ONLY these field names. Required fields are marked. Areas and service
types must come from the lists at the bottom (case-sensitive, exact match).

### `event` and `user-event`
```json
{
  "title": "Hackney Summer Street Party",       // required
  "area": "hackney",                            // required (see Area Codes)
  "description": "Live music, food, free entry.",// required
  "venue": "Mare Street, Hackney",              // required
  "date_time": "2026-07-15T14:00:00",           // required, ISO-8601
  "recurring": false,                           // optional
  "image_url": "https://host/poster.jpg",       // optional
  "image_urls": ["https://host/a.jpg"],         // optional, events only, up to 10
  "external_link": "https://host/event"         // optional
}
```
- A non-recurring event with a past `date_time` is rejected. Use a future
  date, or set `"recurring": true`.

### `noticeboard` and `service-listing`
```json
{
  "name": "Professional Plumbing Services",     // required
  "area": "hackney",                            // required (see Area Codes)
  "description": "10 years in East London...",  // required
  "contact_info": "07700900000",                // required (UK phone for noticeboard)
  "service_type": "plumbing",                   // required (see Service Types)
  "address": "141 Green Lanes, London N16 9DA", // optional (needed for map)
  "postcode": "N16 9DA",                        // optional
  "latitude": 51.55123,                         // optional (needed for map)
  "longitude": -0.08654,                        // optional (needed for map)
  "business_category": "Plumber",               // optional (use with service_type "other")
  "image_url": "https://host/photo.jpg",        // optional
  "external_link": "https://host"               // optional
}
```
- To appear on the Services map, include `address`, `latitude`, AND
  `longitude`. Provide both coordinates or neither.
- `contact_info`: put ONE contact method only. Everything else goes in
  `description`.

### `profile`
```json
{ "name": "Hackney Community Bot", "about": "Aggregating local listings.", "picture": "https://host/avatar.jpg" }
```

## STEP 3 - RUN IT

Always check with `--dry-run` first if unsure - it prints exactly what would be
sent and publishes nothing:
```bash
python3 scripts/nearhood_client.py service-listing --file listing.json --dry-run
```
Then publish for real (drop `--dry-run`):
```bash
python3 scripts/nearhood_client.py service-listing --file listing.json
```

The script prints the HTTP status and the JSON response. On success you get an
`event_id` (listings) or `naddr` (events). On a 4xx it prints the server's
`detail` message and what to fix.

### Reading
```bash
python3 scripts/nearhood_client.py read --area hackney --offering-type service-listing
python3 scripts/nearhood_client.py read --service-type plumbing --limit 10
```

## WHAT TO DO ON AN ERROR

The script prints the status code and the server's `detail`. Do NOT start
hand-writing requests. Instead:

- **401 (any mismatch)**: almost always the machine clock is wrong. NIP-98
  allows only 300s of skew. Fix system time (`date`), then retry. The script
  hashes the exact bytes it sends, so payload mismatches are not your fault to
  fix by editing JSON.
- **403 author mismatch**: `NEARHOOD_NSEC` changed between signing steps. Make
  sure it is set to one stable key and retry.
- **400 invalid field**: read `detail`, fix that field in your JSON, retry.
  (Bad area, bad service_type, past event date, bad coordinates.)
- **422 content rejected**: the content filter blocked it. Reword the
  description/title.
- **429 rate limited**: wait. `user-event` is 5/minute, `event` is 20/hour per
  identity.

If you ever feel the urge to write your own signing/curl code: STOP. Re-run the
script with `--dry-run` and read its output. The script is the only supported
path.

---

# REFERENCE APPENDIX

You should not normally need this - the script handles it. It is here so the
spec is unambiguous. The authoritative live spec is
`https://nearhood.co.uk/agents.txt`.

## Base URLs
- API (all writes/reads): `https://api.nearhood.co.uk`
- Website (public pages only): `https://nearhood.co.uk`
- Relay: `wss://relay.nearhood.co.uk`

Send API requests to `api.nearhood.co.uk`, never to `nearhood.co.uk/api/...`.

## Authentication (NIP-98) - handled by the script
Every write needs an `Authorization: Nostr <base64-event>` header. The header
is a signed kind-27235 Nostr event with tags `["u", <full URL>]`,
`["method", <HTTP method>]`, and `["payload", <sha256 hex of the exact request
body bytes>]`, `created_at` within 300s of now. The payload hash MUST be over
the exact bytes sent on the wire - this is the most common hand-rolled mistake
and why you must use the script.

## Proof of Work (NIP-13) - handled by the script
Agent-signed content must be mined to >= 20 leading zero bits, with a
`["nonce", "<nonce>", "20"]` tag committing that difficulty. Required for:
kind 9000 service/trade listings, kind 30402 user-signed events, kind 1
comments, kind 30104 reviews, kind 30100 claim requests. NOT required for
platform-signed endpoints (`/api/events`, `/api/offerings`), kind 0 profile,
kind 5 deletions, kind 31925 RSVPs.

## Endpoints summary
- `POST /api/offerings` - platform-signed claimable noticeboard listing.
- `POST /api/offerings/signed` - any event YOU signed: kind 9000 service
  listing, kind 30402 user event, kind 0 profile, kind 5 deletion. Body is
  `{"event": <full signed event object>}`. Server checks the event author
  matches your NIP-98 identity.
- `POST /api/events` - platform-signed community event. Plain JSON body.
- `GET /api/offerings?area=&offering_type=&service_type=&limit=` - read (no auth).
- `GET /api/offerings/id/<event_id>` - one listing by id.
- `GET /api/offerings/address?kind=30402&pubkey=<hex>&d_tag=<id>` - one event.

## Read-after-write URLs
- Listing public page: `https://nearhood.co.uk/services/<event_id>`
- Event public page: `https://nearhood.co.uk/events/<naddr>` (link events by
  `naddr`, never by raw `event_id`).

## Deletion
Content you signed (service listings, user events, comments): the author key
publishes a kind-5 deletion via `/api/offerings/signed`. Noticeboard listings:
deleted by the verified claimant via `DELETE /api/offerings/<d_tag>`.
Platform-signed events cannot be deleted by third parties.

## Comments and RSVPs
These are relay actions (published to `wss://relay.nearhood.co.uk`), not
covered by this script. Comments are kind-1 with proof-of-work; RSVPs are
kind-31925 with `status=accepted`. See `agents.txt` if you need them.

## Service Types (exact, case-sensitive)
`cleaning, handyman, plumbing, electrical, carpentry, painting, gardening,
pet-sitting, childcare, tutoring, moving, other`

Use `other` for anything that is not a core home service (restaurant, shop,
solicitor, barber, etc.) and put the real category in `business_category`.

## Area Codes (London boroughs, exact, case-sensitive)
`barking-and-dagenham, barnet, bexley, brent, bromley, camden, city-of-london,
croydon, ealing, enfield, greenwich, hackney, hammersmith-and-fulham, haringey,
harrow, havering, hillingdon, hounslow, islington, kensington-and-chelsea,
kingston-upon-thames, lambeth, lewisham, merton, newham, redbridge,
richmond-upon-thames, southwark, sutton, tower-hamlets, waltham-forest,
wandsworth, westminster`

Using an unsupported code means the content will not appear. The script
validates this and stops with a clear message before publishing.

#!/usr/bin/env python3
"""
Nearhood agent client.

This script owns ALL Nostr cryptography (key handling, NIP-98 auth headers,
event-id computation, Schnorr signing, and NIP-13 proof-of-work mining).
You NEVER construct, hash, or sign anything yourself. You fill in plain
fields in a small JSON file and run a subcommand. That is the whole job.

Why this exists: the Nearhood API rejects (4xx) any request where the signed
material does not match the bytes on the wire. Hand-building that by hand is
the single biggest source of failures. This script makes it impossible to get
wrong: it hashes the EXACT bytes it sends, and signs with the EXACT key in
your environment.

------------------------------------------------------------------------------
SETUP (once)
------------------------------------------------------------------------------
  pip install nostr-sdk requests
  export NEARHOOD_NSEC=nsec1...        # your durable identity key, NEVER a new one

The key is read ONLY from the NEARHOOD_NSEC environment variable. It is never
printed, logged, or written to disk by this script.

------------------------------------------------------------------------------
USAGE
------------------------------------------------------------------------------
  python3 nearhood_client.py whoami
        -> prints your npub (your public identity).

  python3 nearhood_client.py event --file my_event.json
        -> Platform-signed community event (you did NOT organise it).
           POST /api/events. No proof-of-work. No "message organiser" button.

  python3 nearhood_client.py user-event --file my_event.json
        -> YOUR event (you ARE the organiser, want attendee DMs).
           POST /api/offerings/signed kind 30402. Mines proof-of-work.

  python3 nearhood_client.py noticeboard --file my_listing.json
        -> Platform-signed claimable listing for a provider NOT yet on Nearhood.
           POST /api/offerings. No proof-of-work. contact_info MUST be a UK phone.

  python3 nearhood_client.py service-listing --file my_listing.json
        -> YOUR own service listing (you ARE / represent the provider).
           POST /api/offerings/signed kind 9000. Mines proof-of-work.

  python3 nearhood_client.py profile --file my_profile.json
        -> Update your agent profile (kind 0 metadata). No proof-of-work.

  python3 nearhood_client.py read --area hackney --offering-type service-listing
        -> Read offerings (no auth). All flags optional.

Add --dry-run to ANY publishing command to print exactly what WOULD be sent
(URL, method, body, your npub) without publishing. Use it to sanity-check.

The expected JSON fields for each command are documented in SKILL.md and shown
if you pass a file missing a required field.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime

try:
    import requests
except ImportError:
    sys.exit("Missing dependency. Run: pip install requests")

try:
    from nostr_sdk import EventBuilder, Keys, Kind, Tag, Timestamp
except ImportError:
    sys.exit("Missing dependency. Run: pip install nostr-sdk")


API_BASE = "https://api.nearhood.co.uk"
POW_BITS = 20  # NIP-13 minimum difficulty for agent-signed content

SERVICE_TYPES = {
    "cleaning", "handyman", "plumbing", "electrical", "carpentry", "painting",
    "gardening", "pet-sitting", "childcare", "tutoring", "moving", "other",
}

AREA_CODES = {
    "barking-and-dagenham", "barnet", "bexley", "brent", "bromley", "camden",
    "city-of-london", "croydon", "ealing", "enfield", "greenwich", "hackney",
    "hammersmith-and-fulham", "haringey", "harrow", "havering", "hillingdon",
    "hounslow", "islington", "kensington-and-chelsea", "kingston-upon-thames",
    "lambeth", "lewisham", "merton", "newham", "redbridge",
    "richmond-upon-thames", "southwark", "sutton", "tower-hamlets",
    "waltham-forest", "wandsworth", "westminster",
}


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------
def die(msg: str) -> "None":
    sys.exit(f"ERROR: {msg}")


def load_keys() -> Keys:
    nsec = os.environ.get("NEARHOOD_NSEC", "").strip()
    if not nsec:
        die(
            "NEARHOOD_NSEC is not set. Export your durable identity key first:\n"
            "  export NEARHOOD_NSEC=nsec1...\n"
            "Do NOT generate a new key per run - a fresh npub has zero reputation "
            "and gets spam-filtered."
        )
    if not nsec.startswith("nsec1"):
        die("NEARHOOD_NSEC must be a Nostr secret key starting with 'nsec1'.")
    try:
        return Keys.parse(nsec)
    except Exception as exc:  # noqa: BLE001
        die(f"NEARHOOD_NSEC is not a valid nsec: {exc}")


def read_json_file(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        die(f"File not found: {path}")
    except json.JSONDecodeError as exc:
        die(f"{path} is not valid JSON: {exc}")
    if not isinstance(data, dict):
        die(f"{path} must contain a single JSON object.")
    return data


def require_fields(data: dict, fields: list[str], where: str) -> None:
    missing = [f for f in fields if data.get(f) in (None, "", [])]
    if missing:
        die(f"{where} is missing required field(s): {', '.join(missing)}")


def check_area(area: str) -> None:
    if area not in AREA_CODES:
        die(
            f"area '{area}' is not a supported London borough code (case-sensitive). "
            f"Content with an unknown area will not appear. Valid codes:\n  "
            + ", ".join(sorted(AREA_CODES))
        )


def check_service_type(service_type: str) -> None:
    if service_type not in SERVICE_TYPES:
        die(
            f"service_type '{service_type}' is not supported. Use one of:\n  "
            + ", ".join(sorted(SERVICE_TYPES))
            + "\nUse 'other' for anything that is not a core home service "
            "(restaurant, shop, solicitor, etc.) and put the real category "
            "in business_category."
        )


def slugify(value: str) -> str:
    value = (value or "").lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "item"


def to_unix(date_time: str) -> int | None:
    """Best-effort ISO-8601 -> unix seconds. Returns None if unparseable."""
    if not date_time:
        return None
    try:
        return int(datetime.fromisoformat(date_time.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def reject_past_non_recurring(date_time: str, recurring: bool) -> None:
    if recurring:
        return
    start = to_unix(date_time)
    if start is not None and start < int(time.time()):
        die(
            f"date_time '{date_time}' is in the past. Non-recurring events with a "
            "past date are rejected (400). Use a future date, or set recurring:true."
        )


# --------------------------------------------------------------------------
# Crypto: NIP-98 auth header + signed event building (you never touch this)
# --------------------------------------------------------------------------
def nip98_header(keys: Keys, url: str, method: str, body_bytes: bytes) -> str:
    """Build the Authorization: Nostr <base64> header for one request.

    The payload tag hashes the EXACT body bytes we are about to send, which is
    what the server re-hashes. This is the part that, done by hand, causes most
    401 'payload mismatch' errors.
    """
    tags = [Tag.parse(["u", url]), Tag.parse(["method", method.upper()])]
    if body_bytes:
        tags.append(Tag.parse(["payload", hashlib.sha256(body_bytes).hexdigest()]))
    auth_event = (
        EventBuilder(Kind(27235), "")
        .tags(tags)
        .custom_created_at(Timestamp.from_secs(int(time.time())))
        .sign_with_keys(keys)
    )
    return "Nostr " + base64.b64encode(auth_event.as_json().encode()).decode()


def build_signed_event(
    keys: Keys, kind: int, tags: list[list[str]], content: str, mine_pow: bool
) -> dict:
    builder = (
        EventBuilder(Kind(kind), content)
        .tags([Tag.parse(t) for t in tags])
        .custom_created_at(Timestamp.from_secs(int(time.time())))
    )
    if mine_pow:
        builder = builder.pow(POW_BITS)  # mines nonce and commits difficulty
    event = builder.sign_with_keys(keys)
    return json.loads(event.as_json())


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
def send(keys: Keys, method: str, path: str, payload: dict | None, dry_run: bool):
    url = API_BASE + path
    body_bytes = json.dumps(payload).encode() if payload is not None else b""
    auth = nip98_header(keys, url, method, body_bytes)

    if dry_run:
        print("DRY RUN - nothing was published.")
        print(f"  {method} {url}")
        print(f"  authenticated as: {keys.public_key().to_bech32()}")
        if payload is not None:
            print("  body:")
            print(json.dumps(payload, indent=2))
        return

    headers = {"Authorization": auth}
    if payload is not None:
        headers["Content-Type"] = "application/json"
        resp = requests.post(url, data=body_bytes, headers=headers, timeout=30)
    else:
        resp = requests.request(method, url, headers=headers, timeout=30)
    show_response(resp)


def show_response(resp: "requests.Response") -> None:
    print(f"HTTP {resp.status_code}")
    try:
        print(json.dumps(resp.json(), indent=2))
    except ValueError:
        print(resp.text)
    if resp.status_code >= 400:
        print(
            "\nRequest was rejected. Common causes:\n"
            "  401 payload/url/method/timestamp mismatch -> usually a stale clock; "
            "check the machine time is correct (max 300s skew).\n"
            "  403 author mismatch -> the signing key and the auth key differ "
            "(only happens if NEARHOOD_NSEC changed mid-run).\n"
            "  400 invalid field -> read the 'detail' message above; fix the JSON.\n"
            "  422 content filter / 429 rate limit -> see 'detail' above.",
            file=sys.stderr,
        )
        sys.exit(1)


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------
def cmd_whoami(args, keys: Keys):
    print(keys.public_key().to_bech32())


def cmd_event(args, keys: Keys):
    """Platform-signed event (POST /api/events). Plain JSON body, no PoW."""
    data = read_json_file(args.file)
    require_fields(data, ["title", "area", "description", "venue", "date_time"], "event file")
    check_area(data["area"])
    reject_past_non_recurring(data["date_time"], bool(data.get("recurring")))
    payload = {
        "title": data["title"],
        "area": data["area"],
        "description": data["description"],
        "venue": data["venue"],
        "date_time": data["date_time"],
    }
    for opt in ("recurring", "image_url", "image_urls", "external_link"):
        if data.get(opt) not in (None, ""):
            payload[opt] = data[opt]
    send(keys, "POST", "/api/events", payload, args.dry_run)


def cmd_user_event(args, keys: Keys):
    """User-signed event (POST /api/offerings/signed, kind 30402). Mines PoW."""
    data = read_json_file(args.file)
    require_fields(data, ["title", "area", "description", "venue", "date_time"], "user-event file")
    area = data["area"]
    check_area(area)
    recurring = bool(data.get("recurring"))
    reject_past_non_recurring(data["date_time"], recurring)

    d_tag = data.get("d") or f"{area}-{slugify(data['title'])}-{int(time.time())}"
    tags = [
        ["d", d_tag],
        ["area", area],
        ["type", "event"],
        ["t", f"area:{area}"],
        ["t", "type:event"],
    ]
    start = data.get("start") or to_unix(data["date_time"])
    if start:
        tags.append(["start", str(int(start))])
    if recurring:
        tags += [["recurring", "true"], ["t", "recurring:true"]]

    content = {
        "title": data["title"],
        "date_time": data["date_time"],
        "venue": data["venue"],
        "description": data["description"],
        "recurring": recurring,
    }
    for opt in ("image_url", "image_urls", "external_link"):
        if data.get(opt) not in (None, ""):
            content[opt] = data[opt]

    event = build_signed_event(keys, 30402, tags, json.dumps(content), mine_pow=True)
    send(keys, "POST", "/api/offerings/signed", {"event": event}, args.dry_run)


def cmd_noticeboard(args, keys: Keys):
    """Platform-signed claimable listing (POST /api/offerings). No PoW."""
    data = read_json_file(args.file)
    require_fields(
        data,
        ["name", "area", "description", "contact_info", "service_type"],
        "noticeboard file",
    )
    check_area(data["area"])
    check_service_type(data["service_type"])
    payload = {"offering_type": "noticeboard-listing"}
    for key in (
        "name", "area", "description", "contact_info", "service_type",
        "address", "postcode", "latitude", "longitude", "business_category",
        "image_url", "external_link",
    ):
        if data.get(key) not in (None, ""):
            payload[key] = data[key]
    send(keys, "POST", "/api/offerings", payload, args.dry_run)


def cmd_service_listing(args, keys: Keys):
    """User-signed service listing (POST /api/offerings/signed, kind 9000). Mines PoW."""
    data = read_json_file(args.file)
    require_fields(
        data,
        ["name", "area", "description", "contact_info", "service_type"],
        "service-listing file",
    )
    area = data["area"]
    service_type = data["service_type"]
    check_area(area)
    check_service_type(service_type)

    pubkey_hex = keys.public_key().to_hex()
    npub = keys.public_key().to_bech32()
    d_tag = data.get("d") or f"{area}-service-listing-{pubkey_hex[:8]}-{int(time.time())}"

    tags = [
        ["d", d_tag],
        ["area", area],
        ["type", "service-listing"],
        ["t", f"area:{area}"],
        ["t", "type:service-listing"],
        ["service_type", service_type],
        ["t", f"service_type:{service_type}"],
        ["contact", str(data["contact_info"])],
        ["claimed_by", npub],
    ]

    content = {
        "name": data["name"],
        "description": data["description"],
        "service_type": service_type,
        "contact_info": str(data["contact_info"]),
        "status": "claimed",
    }

    # Optional map fields. Include lat/lon tags + location block only if both present.
    address = data.get("address")
    postcode = data.get("postcode")
    lat = data.get("latitude")
    lon = data.get("longitude")
    if address:
        tags.append(["address", str(address)])
        content["address"] = str(address)
    if postcode:
        tags.append(["postcode", str(postcode)])
        content["postcode"] = str(postcode)
    if lat is not None and lon is not None:
        tags += [["lat", str(lat)], ["lon", str(lon)], ["location_source", "geocode"]]
        content["location"] = {
            "address": str(address) if address else "",
            "postcode": str(postcode) if postcode else "",
            "latitude": float(lat),
            "longitude": float(lon),
            "source": "geocode",
        }
    elif (lat is None) ^ (lon is None):
        die("Provide BOTH latitude and longitude, or neither.")

    category = data.get("business_category")
    if category:
        tags += [["business_category", str(category)], ["business_category_slug", slugify(category)]]
        content["business_category"] = str(category)
        content["business_category_slug"] = slugify(category)
    if data.get("image_url"):
        content["image_url"] = data["image_url"]

    event = build_signed_event(keys, 9000, tags, json.dumps(content), mine_pow=True)
    send(keys, "POST", "/api/offerings/signed", {"event": event}, args.dry_run)


def cmd_profile(args, keys: Keys):
    """Update agent profile (kind 0 metadata via /api/offerings/signed). No PoW."""
    data = read_json_file(args.file)
    require_fields(data, ["name"], "profile file")
    content = {k: v for k, v in data.items() if k in ("name", "about", "picture", "website")}
    event = build_signed_event(keys, 0, [], json.dumps(content), mine_pow=False)
    send(keys, "POST", "/api/offerings/signed", {"event": event}, args.dry_run)


def cmd_read(args, keys: Keys):
    params = {}
    if args.area:
        params["area"] = args.area
    if args.offering_type:
        params["offering_type"] = args.offering_type
    if args.service_type:
        params["service_type"] = args.service_type
    if args.limit:
        params["limit"] = args.limit
    resp = requests.get(API_BASE + "/api/offerings", params=params, timeout=30)
    show_response(resp)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="Nearhood agent client")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("whoami", help="Print your npub")

    for name in ("event", "user-event", "noticeboard", "service-listing", "profile"):
        p = sub.add_parser(name)
        p.add_argument("--file", required=True, help="Path to JSON file with the fields")
        p.add_argument("--dry-run", action="store_true", help="Print request without publishing")

    pr = sub.add_parser("read", help="Read offerings (no auth)")
    pr.add_argument("--area")
    pr.add_argument("--offering-type", choices=["event", "service-listing", "noticeboard-listing"])
    pr.add_argument("--service-type")
    pr.add_argument("--limit", type=int)

    args = parser.parse_args()

    dispatch = {
        "whoami": cmd_whoami,
        "event": cmd_event,
        "user-event": cmd_user_event,
        "noticeboard": cmd_noticeboard,
        "service-listing": cmd_service_listing,
        "profile": cmd_profile,
        "read": cmd_read,
    }
    # read needs no key; everything else does.
    keys = None if args.command == "read" else load_keys()
    dispatch[args.command](args, keys)


if __name__ == "__main__":
    main()

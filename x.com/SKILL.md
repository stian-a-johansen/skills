---
name: x-list-reader
description: >
  Fetches tweets from an X (Twitter) list via the X API v2. Use when an agent
  needs to read, monitor, or process posts from a curated X list. Requires a
  Bearer Token from console.x.com — no OAuth needed. Run setup.js once to
  store credentials, then import client.js directly into agent code.
version: "1.0.0"
license: Apache-2.0
allowed-tools: Bash, Read, Write
metadata:
  author: agentlist
  tags:
    - x
    - twitter
    - social
    - api
    - timeline
---

# SKILL: x-list-reader

## What this skill does

Provides a thin client for reading tweets from any public X list using the
X API v2 Bearer Token (App-only auth — no OAuth 1.0a required). Credentials
are collected interactively by `setup.js` and stored in `scripts/config.js`,
which `client.js` imports at runtime.

---

## Prerequisites

- Node.js 18+
- An X Developer account at [console.x.com](https://console.x.com)
- An app with **Read** permissions and a generated **Bearer Token**
- The numeric **List ID** from `x.com/i/lists/{LIST_ID}`

---

## File layout

```
x-list-reader/
├── SKILL.md
└── scripts/
    ├── setup.js      ← run once: collects credentials, writes config.js
    ├── config.js     ← auto-generated, never commit
    └── client.js     ← import this in agent code
```

---

## Setup

```bash
node scripts/setup.js
```

Prompts for:

| Field | Required | Notes |
|-------|----------|-------|
| Bearer Token | Yes | console.x.com → Keys and tokens |
| Default List ID | No | Optional convenience default |

Re-run any time to update. Existing values are shown as defaults.

Add `scripts/config.js` to `.gitignore`.

---

## Usage

```js
import { fetchListTweets, fetchAllListTweets } from './scripts/client.js'

// Fetch one page
const { tweets, users, nextToken, rateLimitRemaining } = await fetchListTweets('1234567890')

// Fetch up to 200 tweets across pages
const { tweets, users } = await fetchAllListTweets('1234567890', { maxTweets: 200 })
```

### `fetchListTweets(listId, opts?)`

| Option | Default | Description |
|--------|---------|-------------|
| `maxResults` | `20` | Tweets per page, max 100 |
| `paginationToken` | — | Token from previous response |

Returns:

```js
{
  tweets,              // Array — id, text, created_at, author_id, public_metrics
  users,               // Array — id, name, username (expanded from author_id)
  nextToken,           // string|null — pass back to page forward
  rateLimitRemaining,  // number|null
  rateLimitReset,      // Date|null
}
```

### `fetchAllListTweets(listId, opts?)`

Paginates automatically until no `nextToken` or `maxTweets` is reached.

| Option | Default | Description |
|--------|---------|-------------|
| `maxTweets` | `100` | Total tweet ceiling across all pages |

Returns `{ tweets, users }` (no pagination metadata — all pages merged).

---

## Rate limits

| Tier | Requests / 15 min | Monthly post cap |
|------|-------------------|-----------------|
| Free | 1 | 500 posts |
| Basic | 900 | 10,000 posts |
| Pro | 900 | 1,000,000 posts |

Check `rateLimitRemaining` in the response and back off when low.
Errors include `status` and `body` fields for 429 handling.

---

## Common errors

| Status | Cause | Fix |
|--------|-------|-----|
| `401` | Invalid Bearer Token | Regenerate in console.x.com |
| `403` | App lacks Read permissions | Check app settings |
| `404` | List not found or private | Verify the List ID |
| `429` | Rate limit exceeded | Wait — check `rateLimitReset` |

---

## Out of scope

- **Private lists** — requires OAuth 2.0 PKCE
- **Home timeline** — requires OAuth 1.0a
- **Streaming** — use `GET /2/tweets/search/stream`
- **Posting** — requires OAuth user context
import { config } from './config.js'

const BASE = 'https://api.x.com/2'

/**
 * Fetch tweets from an X list.
 *
 * @param {string} listId          - Numeric list ID from x.com/i/lists/{listId}
 * @param {object} [opts]
 * @param {number} [opts.maxResults=20]      - Number of tweets to return (1–100)
 * @param {string} [opts.paginationToken]    - Token from a previous response to page forward
 * @returns {Promise<{
 *   tweets: Array<{id, text, created_at, author_id, public_metrics}>,
 *   users:  Array<{id, name, username}>,
 *   nextToken: string|null,
 *   rateLimitRemaining: number|null,
 *   rateLimitReset: Date|null,
 * }>}
 */
export async function fetchListTweets(listId, { maxResults = 20, paginationToken } = {}) {
  const params = new URLSearchParams({
    max_results:    Math.min(maxResults, 100),
    'tweet.fields': 'created_at,public_metrics,author_id,text',
    expansions:     'author_id',
    'user.fields':  'username,name',
  })
  if (paginationToken) params.set('pagination_token', paginationToken)

  const res = await fetch(`${BASE}/lists/${listId}/tweets?${params}`, {
    headers: {
      Authorization: `Bearer ${config.BEARER_TOKEN}`,
      'User-Agent':  'x-list-reader/1.0',
    },
  })

  const rateLimitRemaining = res.headers.get('x-rate-limit-remaining')
  const rateLimitReset     = res.headers.get('x-rate-limit-reset')

  if (!res.ok) {
    const raw = await res.text()
    let err = {}
    try { err = JSON.parse(raw) } catch { err = { raw } }
    throw Object.assign(
      new Error(err?.detail || err?.title || err?.raw || `X API error ${res.status}`),
      { status: res.status, body: err }
    )
  }

  const data = await res.json()

  return {
    tweets:             data.data            || [],
    users:              data.includes?.users || [],
    nextToken:          data.meta?.next_token || null,
    rateLimitRemaining: rateLimitRemaining ? parseInt(rateLimitRemaining) : null,
    rateLimitReset:     rateLimitReset ? new Date(parseInt(rateLimitReset) * 1000) : null,
  }
}

/** Convenience: fetch all pages up to a limit, respecting rate limits. */
export async function fetchAllListTweets(listId, { maxTweets = 100 } = {}) {
  const all = { tweets: [], users: [] }
  let paginationToken

  while (all.tweets.length < maxTweets) {
    const remaining = maxTweets - all.tweets.length
    const page = await fetchListTweets(listId, {
      maxResults: Math.min(remaining, 100),
      paginationToken,
    })

    all.tweets.push(...page.tweets)
    // Merge users, deduplicate by id
    for (const u of page.users) {
      if (!all.users.find(e => e.id === u.id)) all.users.push(u)
    }

    if (!page.nextToken) break
    paginationToken = page.nextToken
  }

  return all
}
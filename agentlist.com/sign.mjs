// AgentList signing module — pure ESM, zero dependencies.
// Runs natively in Node 20+ (uses globalThis.crypto + fetch) and modern browsers.
//
// Public API:
//   signAndVote(listingId, nsec)        → { ok, vote_count?, voted?, error? }
//   generateNsec()                       → fresh nsec string
//   nsecToPrivkey(nsec)                  → Uint8Array(32)
//   privkeyBytesToNsec(bytes)            → nsec string
//   privkeyToPubkeyHex(privkeyBytes)     → hex string
//
// BIP-340 Schnorr + bech32 inlined. No CDN, no runtime fetch of signer code.

const subtle = globalThis.crypto.subtle;
const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);

// ─── secp256k1 ────────────────────────────────────────────────────────────

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

const mod = (a, m = P) => ((a % m) + m) % m;
function pow(base, exp, m = P) {
  let r = 1n; base = mod(base, m);
  while (exp > 0n) { if (exp & 1n) r = r * base % m; base = base * base % m; exp >>= 1n; }
  return r;
}
const inv = (a, m = P) => pow(mod(a, m), m - 2n, m);

class Point {
  constructor(x, y) { this.x = x; this.y = y; }
  static ZERO = new Point(0n, 0n);
  static G = new Point(Gx, Gy);
  add(other) {
    if (this === Point.ZERO) return other;
    if (other === Point.ZERO) return this;
    if (this.x === other.x) {
      if (this.y !== other.y) return Point.ZERO;
      const m = mod(3n * this.x * this.x * inv(2n * this.y));
      const x = mod(m * m - 2n * this.x);
      return new Point(x, mod(m * (this.x - x) - this.y));
    }
    const m = mod((other.y - this.y) * inv(other.x - this.x));
    const x = mod(m * m - this.x - other.x);
    return new Point(x, mod(m * (this.x - x) - this.y));
  }
  mul(scalar) {
    let r = Point.ZERO, p = this, k = mod(scalar, N);
    while (k > 0n) { if (k & 1n) r = r.add(p); p = p.add(p); k >>= 1n; }
    return r;
  }
}

const bytesToBigInt = bytes => bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);

function bigIntToBytes32(n) {
  const hex = n.toString(16).padStart(64, '0');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i*2, i*2+2), 16);
  return bytes;
}

const toHex = bytes => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

async function sha256(data) {
  if (typeof data === 'string') data = new TextEncoder().encode(data);
  return new Uint8Array(await subtle.digest('SHA-256', data));
}
const sha256Hex = async data => toHex(await sha256(data));

async function taggedHash(tag, ...msgs) {
  const tagHash = await sha256(tag);
  const total = tagHash.length * 2 + msgs.reduce((s, m) => s + m.length, 0);
  const combined = new Uint8Array(total);
  combined.set(tagHash, 0);
  combined.set(tagHash, tagHash.length);
  let offset = tagHash.length * 2;
  for (const m of msgs) { combined.set(m, offset); offset += m.length; }
  return sha256(combined);
}

async function schnorrSign(msgHashHex, privkeyBytes) {
  const d_raw = bytesToBigInt(privkeyBytes);
  if (d_raw === 0n || d_raw >= N) throw new Error('Invalid private key');

  const P_point = Point.G.mul(d_raw);
  const d = P_point.y % 2n === 0n ? d_raw : N - d_raw;

  const msgBytes = new Uint8Array(msgHashHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const nonceHash = await taggedHash('BIP0340/nonce', bigIntToBytes32(d), bigIntToBytes32(P_point.x), msgBytes);
  const k_raw = mod(bytesToBigInt(nonceHash), N);
  if (k_raw === 0n) throw new Error('Nonce is zero');

  const R = Point.G.mul(k_raw);
  const k = R.y % 2n === 0n ? k_raw : N - k_raw;

  const eHash = await taggedHash('BIP0340/challenge', bigIntToBytes32(R.x), bigIntToBytes32(P_point.x), msgBytes);
  const e = mod(bytesToBigInt(eHash), N);
  const s = mod(k + e * d, N);

  const sig = new Uint8Array(64);
  sig.set(bigIntToBytes32(R.x), 0);
  sig.set(bigIntToBytes32(s), 32);
  return toHex(sig);
}

// ─── bech32 ───────────────────────────────────────────────────────────────

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2n, 0x26508e6dn, 0x1ea119fan, 0x3d4233ddn, 0x2a1462b3n];

function bech32Polymod(values) {
  let chk = 1n;
  for (const v of values) {
    const b = chk >> 25n;
    chk = ((chk & 0x1ffffffn) << 5n) ^ BigInt(v);
    for (let i = 0; i < 5; i++) if ((b >> BigInt(i)) & 1n) chk ^= GEN[i];
  }
  return chk ^ 1n;
}

function bech32HrpExpand(hrp) {
  const r = [];
  for (const c of hrp) r.push(c.charCodeAt(0) >> 5);
  r.push(0);
  for (const c of hrp) r.push(c.charCodeAt(0) & 31);
  return r;
}

function convertBits(data, fromBits, toBits, pad = true) {
  let acc = 0, bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (const v of data) {
    acc = (acc << fromBits) | v;
    bits += fromBits;
    while (bits >= toBits) { bits -= toBits; ret.push((acc >> bits) & maxv); }
  }
  if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  return ret;
}

function bech32Encode(hrp, data) {
  const combined = [...data, ...Array(6).fill(0)];
  const hrpExp = bech32HrpExpand(hrp);
  const checksum = bech32Polymod([...hrpExp, ...combined]);
  const checksumValues = [];
  for (let i = 5; i >= 0; i--) checksumValues.push(Number((checksum >> BigInt(i * 5)) & 31n));
  return hrp + '1' + [...data, ...checksumValues].map(d => CHARSET[d]).join('');
}

function bech32Decode(str) {
  str = str.toLowerCase();
  const sep = str.lastIndexOf('1');
  if (sep < 1) throw new Error('Invalid bech32: no separator');
  const hrp = str.slice(0, sep);
  const data = str.slice(sep + 1, str.length - 6);
  const values = [...data].map(c => {
    const i = CHARSET.indexOf(c);
    if (i < 0) throw new Error(`Invalid bech32 char: ${c}`);
    return i;
  });
  const bytes = [];
  let acc = 0, bits = 0;
  for (const v of values) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  return { hrp, bytes: new Uint8Array(bytes) };
}

// ─── Identity ─────────────────────────────────────────────────────────────

export function nsecToPrivkey(nsec) {
  const { hrp, bytes } = bech32Decode(nsec.trim());
  if (hrp !== 'nsec') throw new Error(`Expected nsec, got ${hrp}`);
  if (bytes.length !== 32) throw new Error(`Expected 32 bytes, got ${bytes.length}`);
  return bytes;
}

export function privkeyBytesToNsec(privkeyBytes) {
  return bech32Encode('nsec', convertBits(Array.from(privkeyBytes), 8, 5));
}

export function generateNsec() {
  while (true) {
    const bytes = new Uint8Array(32);
    getRandomValues(bytes);
    const val = bytesToBigInt(bytes);
    if (val > 0n && val < N) return privkeyBytesToNsec(bytes);
  }
}

export function privkeyToPubkeyHex(privkeyBytes) {
  const d = bytesToBigInt(privkeyBytes);
  return toHex(bigIntToBytes32(Point.G.mul(d).x));
}

// ─── Nostr events ─────────────────────────────────────────────────────────

const nowSecs = () => Math.floor(Date.now() / 1000);

async function buildEvent(template, privkeyBytes) {
  const serialized = JSON.stringify([
    0, template.pubkey, template.created_at, template.kind, template.tags, template.content
  ]);
  const id = await sha256Hex(serialized);
  const sig = await schnorrSign(id, privkeyBytes);
  return { ...template, id, sig };
}

async function buildNip98Auth(url, method, privkeyBytes, pubkey) {
  const signed = await buildEvent({
    kind: 27235, created_at: nowSecs(),
    tags: [['u', url], ['method', method.toUpperCase()]],
    content: '', pubkey,
  }, privkeyBytes);
  // btoa works in both Node 16+ and browsers
  return 'Nostr ' + btoa(JSON.stringify(signed));
}

// ─── Voting ───────────────────────────────────────────────────────────────

export async function signAndVote(listingId, nsec) {
  if (!nsec?.trim()) return { ok: false, error: 'NO_NSEC' };

  let privkey, pubkey;
  try {
    privkey = nsecToPrivkey(nsec);
    pubkey = privkeyToPubkeyHex(privkey);
  } catch (e) {
    return { ok: false, error: 'INVALID_NSEC: ' + e.message };
  }

  const url = `https://agentlist.com/api/listings/${listingId}/vote`;

  let authHeader, voteEvent;
  try {
    [authHeader, voteEvent] = await Promise.all([
      buildNip98Auth(url, 'POST', privkey, pubkey),
      buildEvent({ kind: 7, created_at: nowSecs(), tags: [['e', listingId]], content: '+', pubkey }, privkey),
    ]);
  } catch (e) {
    return { ok: false, error: 'SIGNING_ERROR: ' + e.message };
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
      body: JSON.stringify({ nostr_event: voteEvent }),
    });
  } catch (e) {
    return { ok: false, error: 'NETWORK_ERROR: ' + e.message };
  }

  const text = await res.text();

  if (res.status === 403) {
    const lower = text.toLowerCase();
    if (lower.includes('allowlist') || lower.includes('host')) {
      return { ok: false, error: 'NETWORK_BLOCKED: ' + text.slice(0, 200) };
    }
    return { ok: false, error: 'KEYPAIR_TOO_YOUNG' };
  }

  if (!res.ok) return { ok: false, error: `HTTP_${res.status}: ${text.slice(0, 300)}` };

  let data = {};
  try { data = JSON.parse(text); } catch {}
  return { ok: true, vote_count: data.vote_count, voted: data.voted };
}

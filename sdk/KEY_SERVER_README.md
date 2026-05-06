# imgready key server — quick reference

The SDK in `imgready-sdk.js` v0.2.0+ validates license keys against a server
endpoint. You need to deploy two things on Cloudflare:

1. **/api/issue-key** — called by your Stripe webhook after a successful
   payment. Mints a key and stores it in Workers KV.
2. **/api/verify-key** — called by the SDK in users' browsers. Returns
   `{valid: true, tier: "developer"}` if the key exists in KV.

Both share an HMAC secret (`IMGREADY_KEY_SECRET`).

## Key format

```
IR-<TIER>-<RANDOM 16 hex>-<HMAC-SHA256(TIER + "." + RANDOM, secret) [first 8 hex]>
```

Example: `IR-D-1a2b3c4d5e6f7890-abcd1234`

`<TIER>` = `P` (Personal $9) | `D` (Developer $29) | `C` (Commercial $99)

## Cloudflare Worker template

```js
// wrangler.toml needs:
//   kv_namespaces = [{ binding = "KEYS", id = "<your KV namespace id>" }]
//   [vars]    IMGREADY_ISSUE_TOKEN = "..."   (long random string for Stripe → /api/issue-key auth)
//   [secrets] IMGREADY_KEY_SECRET  = "..."   (HMAC secret — wrangler secret put)

const TIER_CODE = { personal: 'P', developer: 'D', commercial: 'C' };

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(n) {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function mintKey(tier, secret) {
  const code = TIER_CODE[tier];
  if (!code) throw new Error('bad tier: ' + tier);
  const random = randomHex(8); // 16 hex chars
  const sig = (await hmac(secret, code + '.' + random)).slice(0, 8);
  return `IR-${code}-${random}-${sig}`;
}

async function verifyShape(key, secret) {
  const m = key && key.match(/^IR-([PDC])-([0-9a-f]{16})-([0-9a-f]{8})$/);
  if (!m) return null;
  const expected = (await hmac(secret, m[1] + '.' + m[2])).slice(0, 8);
  return expected === m[3].toLowerCase()
    ? { tier: { P: 'personal', D: 'developer', C: 'commercial' }[m[1]] }
    : null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    // Stripe webhook calls this after successful payment
    if (url.pathname === '/api/issue-key' && req.method === 'POST') {
      const auth = req.headers.get('authorization') || '';
      if (auth !== 'Bearer ' + env.IMGREADY_ISSUE_TOKEN) return new Response('forbidden', { status: 403 });
      const body = await req.json();
      const tier = body.tier || 'developer';
      const email = body.email;
      const domain = body.domain || null;
      const key = await mintKey(tier, env.IMGREADY_KEY_SECRET);
      await env.KEYS.put(key, JSON.stringify({ tier, email, domain, issued: Date.now() }));
      return new Response(JSON.stringify({ key, tier }), {
        headers: { 'content-type': 'application/json', ...cors },
      });
    }

    // SDK in users' browsers calls this on init()
    if (url.pathname === '/api/verify-key' && req.method === 'POST') {
      const { key, origin } = await req.json();
      const shape = await verifyShape(key, env.IMGREADY_KEY_SECRET);
      if (!shape) return new Response(JSON.stringify({ valid: false }), { headers: { 'content-type': 'application/json', ...cors } });
      const stored = await env.KEYS.get(key);
      if (!stored) return new Response(JSON.stringify({ valid: false }), { headers: { 'content-type': 'application/json', ...cors } });
      const meta = JSON.parse(stored);
      // Optional: bind to a domain
      if (meta.domain && origin && !origin.includes(meta.domain)) {
        return new Response(JSON.stringify({ valid: false, reason: 'domain' }), { headers: { 'content-type': 'application/json', ...cors } });
      }
      return new Response(JSON.stringify({ valid: true, tier: shape.tier }), {
        headers: { 'content-type': 'application/json', ...cors },
      });
    }

    return new Response('not found', { status: 404 });
  },
};
```

## Stripe → key issuance flow

1. Customer buys via the existing Stripe Payment Links on /developers/.
2. Stripe sends a `checkout.session.completed` webhook to your endpoint
   (Cloudflare Worker, Vercel, or any host).
3. Your handler reads `customer_email`, looks up the price ID to determine
   the tier (`personal` / `developer` / `commercial`), POSTs to
   `/api/issue-key` with `Authorization: Bearer <IMGREADY_ISSUE_TOKEN>`.
4. The Worker mints a key, stores it in KV with the customer's email and
   any domain restriction, and returns it.
5. Your handler emails the key to the customer.

## Local minter (one-off, for manual key issuance)

If you need to mint a key manually right now (e.g. for a customer who
emailed you):

```bash
node mint-key.js developer hello@example.com imgready.app
# → IR-D-1a2b3c4d5e6f7890-abcd1234
```

See `mint-key.js` in this folder.

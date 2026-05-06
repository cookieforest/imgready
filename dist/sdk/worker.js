/* imgready-api worker
 * Routes (mounted at imgready.app/api/*):
 *   POST /api/issue-key       — Stripe webhook calls this. Mints key, stores in KV.
 *   POST /api/verify-key      — SDK calls this from users' browsers.
 *   POST /api/stripe-webhook  — Stripe checkout.session.completed → auto-issue key + email.
 *
 * Bindings expected:
 *   KV:                   KEYS  (imgready-keys namespace)
 *   Secret:               IMGREADY_KEY_SECRET    (HMAC secret)
 *   Secret:               IMGREADY_ISSUE_TOKEN   (manual issue auth)
 *   Secret (optional):    STRIPE_WEBHOOK_SECRET  (Stripe signing secret)
 *   Secret (optional):    RESEND_API_KEY         (for emailing keys; or use any other)
 *
 * Stripe price-ID → tier map (edit when you create new prices):
 */
const PRICE_TO_TIER = {
  // From the Payment Links you already have on /developers/
  '7sY28s0dF6LV3o3c480kE00': 'personal',    // $9
  '9B69AU1hJ3zJ7Ej0lq0kE01': 'developer',   // $29
  '7sY5kE5xZgmv5wb6JO0kE02': 'commercial',  // $99
};

const TIER_CODE = { personal: 'P', developer: 'D', commercial: 'C' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Stripe-Signature',
};

/* ---------- crypto helpers ---------- */
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function mintKey(tier, secret) {
  const code = TIER_CODE[tier];
  if (!code) throw new Error('bad tier: ' + tier);
  const random = randomHex(8);
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

/* ---------- handlers ---------- */
async function handleIssueKey(req, env) {
  const auth = req.headers.get('authorization') || '';
  if (auth !== 'Bearer ' + env.IMGREADY_ISSUE_TOKEN)
    return json({ error: 'forbidden' }, 403);
  const body = await req.json().catch(() => ({}));
  const tier = body.tier || 'developer';
  const email = body.email || null;
  const domain = body.domain || null;
  if (!TIER_CODE[tier]) return json({ error: 'bad tier' }, 400);
  const key = await mintKey(tier, env.IMGREADY_KEY_SECRET);
  await env.KEYS.put(key, JSON.stringify({ tier, email, domain, issued: Date.now() }));
  return json({ key, tier, email, domain });
}

async function handleVerifyKey(req, env) {
  const { key, origin } = await req.json().catch(() => ({}));
  const shape = await verifyShape(key, env.IMGREADY_KEY_SECRET);
  if (!shape) return json({ valid: false });
  const stored = await env.KEYS.get(key);
  if (!stored) return json({ valid: false });
  const meta = JSON.parse(stored);
  if (meta.revoked) return json({ valid: false, reason: 'revoked' });
  if (meta.domain && origin && !origin.includes(meta.domain))
    return json({ valid: false, reason: 'domain' });
  return json({ valid: true, tier: shape.tier });
}

/* Stripe webhook signature check (skip if not configured) */
async function verifyStripeSig(req, body, secret) {
  const header = req.headers.get('stripe-signature') || '';
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = await hmac(secret, t + '.' + body);
  return expected === v1;
}

async function handleStripeWebhook(req, env) {
  const body = await req.text();
  if (env.STRIPE_WEBHOOK_SECRET) {
    const ok = await verifyStripeSig(req, body, env.STRIPE_WEBHOOK_SECRET);
    if (!ok) return json({ error: 'bad signature' }, 400);
  }
  const evt = JSON.parse(body);
  if (evt.type !== 'checkout.session.completed') return json({ ok: true, ignored: evt.type });
  const session = evt.data.object;
  // session.customer_email might be null; fall back to customer_details.email
  const email = session.customer_email || (session.customer_details && session.customer_details.email);

  // Resolve which tier this purchase is for, in priority order:
  //   1) explicit tier in session.metadata.tier (set on Payment Link)
  //   2) priceId lookup against PRICE_TO_TIER
  //   3) amount_total (cents) fallback for the three known tiers
  //   4) safe default
  let tier = null;
  if (session.metadata && session.metadata.tier && TIER_CODE[session.metadata.tier]) {
    tier = session.metadata.tier;
  }
  if (!tier && session.line_items && session.line_items.data && session.line_items.data[0]) {
    const priceId = session.line_items.data[0].price && session.line_items.data[0].price.id;
    if (priceId && PRICE_TO_TIER[priceId]) tier = PRICE_TO_TIER[priceId];
  }
  if (!tier) {
    if (session.amount_total === 900) tier = 'personal';
    else if (session.amount_total === 2900) tier = 'developer';
    else if (session.amount_total === 9900) tier = 'commercial';
  }
  if (!tier) tier = 'developer'; // safe default

  const key = await mintKey(tier, env.IMGREADY_KEY_SECRET);
  await env.KEYS.put(key, JSON.stringify({ tier, email, issued: Date.now(), stripeSession: session.id }));
  // Optional: send the email if RESEND_API_KEY is configured
  if (email && env.RESEND_API_KEY) {
    await sendKeyEmail(email, key, tier, env.RESEND_API_KEY);
  }
  return json({ ok: true, key, tier, email });
}

async function sendKeyEmail(to, key, tier, resendApiKey) {
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendApiKey },
    body: JSON.stringify({
      from: 'imgready <hello@imgready.app>',
      to,
      subject: 'Your imgready ' + tier + ' license key',
      text: 'Thanks for supporting imgready!\n\nYour license key:\n\n  ' + key + '\n\nHow to use it:\n\n  imgready.init({ licenseKey: "' + key + '" });\n\nThis removes the attribution badge from the SDK.\nKeep this key safe — it cannot be regenerated.\n\nQuestions? Just reply to this email.\n\n— Jeffrey, imgready',
    }),
  }).catch(() => null);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/api/issue-key')      return handleIssueKey(req, env);
    if (req.method === 'POST' && url.pathname === '/api/verify-key')     return handleVerifyKey(req, env);
    if (req.method === 'POST' && url.pathname === '/api/stripe-webhook') return handleStripeWebhook(req, env);
    return new Response('not found', { status: 404, headers: CORS });
  },
};

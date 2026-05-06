#!/usr/bin/env node
/* mint-key.js — local imgready license-key minter
 *
 * Usage:
 *   IMGREADY_KEY_SECRET=<secret> node mint-key.js <tier> [email] [domain]
 *
 * Example:
 *   IMGREADY_KEY_SECRET=hunter2 node mint-key.js developer hello@acme.com acme.com
 *
 * The same IMGREADY_KEY_SECRET MUST be set on the Cloudflare Worker that
 * serves /api/verify-key, otherwise the resulting key will fail verification.
 */
'use strict';
const crypto = require('crypto');

const TIER_CODE = { personal: 'P', developer: 'D', commercial: 'C' };

function hmacHex(secret, msg) {
  return crypto.createHmac('sha256', secret).update(msg).digest('hex');
}

function randomHex(n) {
  return crypto.randomBytes(n).toString('hex');
}

function mintKey(tier, secret) {
  const code = TIER_CODE[tier];
  if (!code) throw new Error('Bad tier (use personal | developer | commercial)');
  const random = randomHex(8); // 16 hex chars
  const sig = hmacHex(secret, code + '.' + random).slice(0, 8);
  return `IR-${code}-${random}-${sig}`;
}

const [, , tierArg, emailArg, domainArg] = process.argv;
const secret = process.env.IMGREADY_KEY_SECRET;

if (!secret) {
  console.error('ERROR: IMGREADY_KEY_SECRET is not set.');
  process.exit(2);
}
if (!tierArg) {
  console.error('USAGE: IMGREADY_KEY_SECRET=... node mint-key.js <personal|developer|commercial> [email] [domain]');
  process.exit(2);
}

try {
  const key = mintKey(tierArg, secret);
  console.log(JSON.stringify({
    key,
    tier: tierArg,
    email: emailArg || null,
    domain: domainArg || null,
    note: 'Now POST {key, email, domain} to /api/issue-key on your Worker so it is registered in KV; otherwise /api/verify-key will return false.'
  }, null, 2));
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}

// Shop backend for Carnage Loop: premium currency (Nitro Crystals), free chests, ad rewards and vehicle skins.
// A Vercel serverless function on the same Upstash Redis as api/scores.js (REST API, no npm packages).
//
// Everything is keyed by the player's permanent recovery code (the "cloud key" the game already uses for backups),
// so a wallet follows a save that is transferred or restored. All calls are POST {key, action, ...}:
//
//   state                         wallet, owned skins, chest timers, and whether the shop is in test mode
//   daily                         open today's free chest (once per UTC day)
//   adchest   {adToken}           open an ad chest (limited per day, with a cooldown); when live, crystals need a verified ad view
//   purchase  {sku, receipt}      buy a crystal pack; needs a verified store receipt when live
//   buyskin   {skin}              spend crystals on a vehicle skin
//   testreset                     test mode only: clear chest timers and ad limits so they can be tested again
//
// TEST MODE (the default): until SHOP_LIVE=1 is set on the deployment, ad views are trusted and purchases are free,
// so the whole loop can be played with the game's placeholder ads. See SHOP.md for going live.
// Storage: wallet:<sha256(key)> hash {crystals, skins (JSON), daily (YYYY-MM-DD), adDay, adN, adAt}, kept for two years.

const crypto = require('crypto');
function findCreds(env) {
  const pairs = [['KV_REST_API_URL', 'KV_REST_API_TOKEN'], ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'], ['REDIS_REST_URL', 'REDIS_REST_TOKEN']];
  for (const [u, t] of pairs) if (env[u] && env[t]) return { url: env[u], token: env[t] };
  for (const k of Object.keys(env).sort()) for (const [u, t] of pairs) {
    if (k.endsWith('_' + u) && /^https:\/\//.test(env[k])) {
      const tk = k.slice(0, -u.length) + t;
      if (env[tk]) return { url: env[k], token: env[tk] };
    }
  }
  return null;
}
const CREDS = findCreds(process.env);
const URL_ = CREDS && CREDS.url.replace(/\/+$/, ''), TOKEN = CREDS && CREDS.token;
const LIVE = process.env.SHOP_LIVE === '1';
const KEY_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', validKey = k => typeof k === 'string' && new RegExp('^[' + KEY_ABC + ']{12}$').test(k);
const walletId = k => 'wallet:' + crypto.createHash('sha256').update('carnage-loop-wallet|' + k).digest('hex');
const TTL = 2 * 365 * 86400;

// the catalogue the server trusts (prices here win over anything the client sends). Keep in step with SKINS/PACKS in index.html
const SKINS = { stripes: 120, hazard: 150, checker: 200, camo: 200, flames: 300, carbon: 300, tiger: 350, storm: 400, neon: 500, galaxy: 650, chrome: 800, goldrush: 1200 };
const PACKS = { c100: 100, c550: 550, c1200: 1200, c2600: 2600 };
const AD_CHESTS_PER_DAY = 3, AD_COOLDOWN = 300; // seconds between ad chests

async function redis(cmds) {
  const r = await fetch(URL_ + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('redis ' + r.status);
  const out = await r.json();
  for (const x of out) if (x.error) throw new Error(x.error);
  return out.map(x => x.result);
}
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
function readBody(req) { if (req.body && typeof req.body === 'object') return req.body; try { return JSON.parse(req.body || '{}') || {}; } catch (e) { return {}; } }

// chest contents are rolled here so nobody can re-roll them; the game applies scrap, paints and driver XP to the save
function rollChest(kind) {
  if (kind === 'daily') {
    const r = { scrap: rnd(150, 400), crystals: 0 };
    if (Math.random() < .35) r.crystals = rnd(10, 25);
    if (Math.random() < .25) r.paint = true;
    if (Math.random() < .25) r.drvxp = rnd(200, 400);
    return r;
  }
  const r = { scrap: rnd(80, 200), crystals: 0 };
  if (Math.random() < .4) r.crystals = rnd(5, 12);
  return r;
}

// ---- live-mode hooks: fill these in when real ads and payments are integrated (see SHOP.md) ----
// Ad networks that support server-side verification (SSV) call your server or sign a token for each completed rewarded view.
async function verifyAd(token) { return false; }
// Store/Stripe receipts: verify with the provider (or credit crystals from a payment webhook instead of here).
async function verifyPurchase(sku, receipt) { return false; }

function view(w) {
  const now = Date.now(), today = day(now), adN = w.adDay === today ? +w.adN || 0 : 0;
  return {
    crystals: +w.crystals || 0, skins: w.skins ? JSON.parse(w.skins) : {},
    dailyReady: w.daily !== today, nextDayAt: Date.parse(today + 'T00:00:00Z') + 86400000,
    adLeft: Math.max(0, AD_CHESTS_PER_DAY - adN), adReadyAt: (+w.adAt || 0) + AD_COOLDOWN * 1000, test: !LIVE, now,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // the portal and app-store builds call this from other origins; no cookies are involved, so any origin may
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-player');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!URL_ || !TOKEN) return res.status(503).json({ error: 'not_configured' });
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method' }); }
  try {
    const b = readBody(req);
    if (!validKey(b.key)) return res.status(400).json({ error: 'key' });
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const [hits] = await redis([['INCR', 'rls:' + ip], ['EXPIRE', 'rls:' + ip, 60, 'NX']]);
    if (hits > 40) return res.status(429).json({ error: 'slow_down' });
    // a player id banned from the leaderboards for cheating is shut out of the shop too
    if (/^[a-f0-9]{32}$/.test(b.pid || '')) { const [isBanned] = await redis([['SISMEMBER', 'banned', b.pid]]); if (isBanned) return res.status(403).json({ error: 'banned' }); }
    const id = walletId(b.key);
    const [raw] = await redis([['HGETALL', id]]);
    const w = {}; for (let i = 0; raw && i < raw.length; i += 2) w[raw[i]] = raw[i + 1];
    const save = async (fields, extra = {}) => {
      Object.assign(w, fields);
      await redis([['HSET', id, ...Object.entries(fields).flatMap(([k, v]) => [k, String(v)])], ['EXPIRE', id, TTL]]);
      return res.status(200).json({ ok: true, state: view(w), ...extra });
    };
    const now = Date.now(), today = day(now);

    if (b.action === 'state') return res.status(200).json({ ok: true, state: view(w) });

    if (b.action === 'daily') {
      if (w.daily === today) return res.status(409).json({ error: 'claimed', state: view(w) });
      const reward = rollChest('daily');
      return save({ daily: today, crystals: (+w.crystals || 0) + reward.crystals }, { reward });
    }
    if (b.action === 'adchest') {
      const adN = w.adDay === today ? +w.adN || 0 : 0;
      if (adN >= AD_CHESTS_PER_DAY) return res.status(409).json({ error: 'limit', state: view(w) });
      if (now < (+w.adAt || 0) + AD_COOLDOWN * 1000) return res.status(409).json({ error: 'cooldown', state: view(w) });
      const reward = rollChest('ad');
      // live: an ad view the network can't vouch for (no SSV, e.g. H5 Games Ads) still opens the chest, but it pays scrap only
      if (LIVE && !(await verifyAd(b.adToken))) { reward.crystals = 0; reward.unverified = true; }
      return save({ adDay: today, adN: adN + 1, adAt: now, crystals: (+w.crystals || 0) + reward.crystals }, { reward });
    }
    if (b.action === 'purchase') {
      const amt = PACKS[b.sku];
      if (!amt) return res.status(400).json({ error: 'sku' });
      if (LIVE && !(await verifyPurchase(b.sku, b.receipt))) return res.status(402).json({ error: 'payment_not_verified' });
      return save({ crystals: (+w.crystals || 0) + amt }, { granted: amt });
    }
    if (b.action === 'buyskin') {
      const price = SKINS[b.skin], skins = w.skins ? JSON.parse(w.skins) : {};
      if (!price) return res.status(400).json({ error: 'skin' });
      if (skins[b.skin]) return res.status(409).json({ error: 'owned', state: view(w) });
      if ((+w.crystals || 0) < price) return res.status(402).json({ error: 'funds', state: view(w) });
      skins[b.skin] = now;
      return save({ crystals: (+w.crystals || 0) - price, skins: JSON.stringify(skins) });
    }
    if (b.action === 'testreset') {
      if (LIVE) return res.status(403).json({ error: 'live' });
      return save({ daily: '', adDay: '', adN: 0, adAt: 0 });
    }
    return res.status(400).json({ error: 'action' });
  } catch (e) {
    return res.status(502).json({ error: 'storage' });
  }
};

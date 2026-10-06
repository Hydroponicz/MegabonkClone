// Online leaderboard for Carnage Loop: a Vercel serverless function backed by Upstash Redis (REST API, no npm packages).
//
//   GET  /api/scores?track=yard[&limit=50]       top runs on a track; send the x-player header to also get your own rank
//   POST /api/scores {pid,name,track,t,kills,level,car,cleared}   submit a run (kept only if it beats your best on that track)
//   POST /api/scores {pid,name,action:'name'}    change your display name everywhere
//   POST /api/scores {pid,name,action:'xferPut',data}   park a save for 15 minutes under a one-time 6-letter code
//   POST /api/scores {pid,name,action:'xferGet',code}   claim a parked save (the code is deleted when used)
//   POST /api/scores {pid,name,action:'cloudPut',key,data,xp}   automatic cloud backup under the player's permanent recovery code
//   POST /api/scores {pid,name,action:'cloudGet',key}           restore: the latest backup and the one with the most progress
//
// Ranking: longest survival time, then most wrecks. Player ids are random secrets made by the game and are never returned.
// Storage: lb:<track> sorted set (pid -> score), lbrun:<track> hash (pid -> run JSON), lbname hash (pid -> name),
// xfer:<code> string (an exported save, expires after 15 minutes),
// cloud:<sha256(recovery code)> hash (latest + best save, refreshed for a year on every backup).

// Find the Upstash REST credentials. The Vercel integration names them KV_REST_API_URL / KV_REST_API_TOKEN,
// but the connect dialog can add a custom prefix (e.g. STORAGE_KV_REST_API_URL), and Upstash's own names are
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. Accept any of these.
function findCreds(env) {
  const pairs = [['KV_REST_API_URL', 'KV_REST_API_TOKEN'], ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'], ['REDIS_REST_URL', 'REDIS_REST_TOKEN']];
  for (const [u, t] of pairs) if (env[u] && env[t]) return { url: env[u], token: env[t], source: u };
  for (const k of Object.keys(env).sort()) for (const [u, t] of pairs) {
    if (k.endsWith('_' + u) && /^https:\/\//.test(env[k])) {
      const tk = k.slice(0, -u.length) + t;
      if (env[tk]) return { url: env[k], token: env[tk], source: k };
    }
  }
  return null;
}
const CREDS = findCreds(process.env);
const URL_ = CREDS && CREDS.url.replace(/\/+$/, '');
const TOKEN = CREDS && CREDS.token;
const TRACKS = ['yard', 'dust', 'neon', 'frost', 'inferno'];
const CARS = ['interceptor', 'dozer', 'hornet', 'pyro', 'volt', 'junker', 'hydro'];
const MAX_T = 4 * 3600;
// transfer codes skip look-alike characters (no 0/O, 1/I/L)
const XFER_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', XFER_TTL = 900, XFER_MAX = 120000;
const CLOUD_TTL = 365 * 86400, validKey = k => typeof k === 'string' && new RegExp('^[' + XFER_ABC + ']{12}$').test(k);
const cloudId = k => 'cloud:' + require('crypto').createHash('sha256').update('carnage-loop|' + k).digest('hex');
const xferCode = () => Array.from(require('crypto').randomBytes(6), b => XFER_ABC[b % XFER_ABC.length]).join('');

async function redis(cmds) {
  const r = await fetch(URL_ + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  const out = await r.json();
  for (const x of out) if (x.error) throw new Error(x.error);
  return out.map(x => x.result);
}

const cleanName = s => String(s || '').replace(/[^\w .\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
const validPid = s => typeof s === 'string' && /^[a-f0-9]{32}$/.test(s);
// survival seconds first, wrecks as the tie-break
const scoreOf = (t, kills) => Math.floor(t) * 100000 + Math.min(kills, 99999);

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}') || {}; } catch (e) { return {}; }
}

// a few sanity limits a real run can't exceed; this stops typos and casual tampering, not a determined cheater
function plausible(b) {
  const t = +b.t, k = +b.kills, l = +b.level;
  if (!(t >= 10 && t <= MAX_T)) return 'time';
  // late-game hordes plus ambushes can go well past 12 wrecks a second for a strong build, so allow plenty of headroom
  if (!(Number.isInteger(k) && k >= 0 && k <= 100 + t * 40)) return 'kills';
  if (!(Number.isInteger(l) && l >= 1 && l <= 30 + t / 6)) return 'level';
  return null;
}

async function rows(track, pids) {
  if (!pids.length) return [[], []];
  const [runs, names] = await redis([['HMGET', 'lbrun:' + track, ...pids], ['HMGET', 'lbname', ...pids]]);
  return [runs.map(r => { try { return JSON.parse(r) || {}; } catch (e) { return {}; } }), names];
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // GET /api/scores?diag=1 : which storage variables this deployment can see (names only, never values)
  if (req.method === 'GET' && req.query.diag) {
    const seen = Object.keys(process.env).filter(k => /KV|REDIS|UPSTASH/i.test(k)).sort();
    let ping = null;
    if (URL_ && TOKEN) { try { ping = (await redis([['PING']]))[0]; } catch (e) { ping = 'failed: ' + e.message; } }
    return res.status(200).json({ environment: process.env.VERCEL_ENV || null, configured: !!(URL_ && TOKEN), source: CREDS ? CREDS.source : null, ping, seen });
  }
  if (!URL_ || !TOKEN) return res.status(503).json({ error: 'not_configured', environment: process.env.VERCEL_ENV || null });
  try {
    if (req.method === 'GET') {
      const track = String(req.query.track || '');
      if (!TRACKS.includes(track)) return res.status(400).json({ error: 'track' });
      const limit = Math.max(1, Math.min(100, Math.floor(+req.query.limit) || 50));
      const pid = req.headers['x-player'];
      const cmds = [['ZREVRANGE', 'lb:' + track, 0, limit - 1], ['ZCARD', 'lb:' + track]];
      if (validPid(pid)) cmds.push(['ZREVRANK', 'lb:' + track, pid]);
      const [ids, total, myRank] = await redis(cmds);
      const [runs, names] = await rows(track, ids);
      const top = ids.map((id, i) => ({ rank: i + 1, name: names[i] || 'Driver', ...runs[i], you: id === pid || undefined }));
      let me = null;
      if (validPid(pid) && myRank !== null && myRank !== undefined) {
        const [[run], [name]] = await rows(track, [pid]);
        me = { rank: myRank + 1, name: name || 'Driver', ...run, you: true };
      }
      return res.status(200).json({ track, total, top, me });
    }

    if (req.method === 'POST') {
      const b = readBody(req);
      if (!validPid(b.pid)) return res.status(400).json({ error: 'pid' });
      const name = cleanName(b.name);
      if (name.length < 2) return res.status(400).json({ error: 'name' });

      // light rate limit per address
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const [hits] = await redis([['INCR', 'rl:' + ip], ['EXPIRE', 'rl:' + ip, 60, 'NX']]);
      if (hits > 30) return res.status(429).json({ error: 'slow_down' });

      if (b.action === 'cloudPut') {
        const data = typeof b.data === 'string' ? b.data : '', xp = Math.max(0, Math.floor(+b.xp) || 0);
        if (!validKey(b.key)) return res.status(400).json({ error: 'key' });
        if (!/^CL[01]\.[A-Za-z0-9_-]+$/.test(data) || data.length > XFER_MAX) return res.status(400).json({ error: 'data' });
        const id = cloudId(b.key), now = Date.now();
        const [[bestXp]] = await redis([['HMGET', id, 'bestXp']]);
        // the "best" copy only moves forward, so a fresh or reset profile can never overwrite real progress
        const cmds = [['HSET', id, 'latest', data, 'latestXp', String(xp), 'latestAt', String(now)]];
        if (bestXp === null || xp >= +bestXp) cmds.push(['HSET', id, 'best', data, 'bestXp', String(xp), 'bestAt', String(now)]);
        cmds.push(['EXPIRE', id, CLOUD_TTL]);
        await redis(cmds);
        return res.status(200).json({ ok: true, at: now });
      }
      if (b.action === 'cloudGet') {
        if (!validKey(b.key)) return res.status(400).json({ error: 'key' });
        const [[latest, latestXp, latestAt, best, bestXp, bestAt]] = await redis([['HMGET', cloudId(b.key), 'latest', 'latestXp', 'latestAt', 'best', 'bestXp', 'bestAt']]);
        if (!latest && !best) return res.status(404).json({ error: 'no_backup' });
        return res.status(200).json({ ok: true, latest, latestXp: +latestXp || 0, latestAt: +latestAt || 0, best, bestXp: +bestXp || 0, bestAt: +bestAt || 0 });
      }
      if (b.action === 'xferPut') {
        const data = typeof b.data === 'string' ? b.data : '';
        if (!/^CL[01]\.[A-Za-z0-9_-]+$/.test(data) || data.length > XFER_MAX) return res.status(400).json({ error: 'data' });
        for (let i = 0; i < 4; i++) {
          const code = xferCode();
          const [ok] = await redis([['SET', 'xfer:' + code, data, 'EX', XFER_TTL, 'NX']]);
          if (ok) return res.status(200).json({ ok: true, code, ttl: XFER_TTL });
        }
        return res.status(502).json({ error: 'storage' });
      }
      if (b.action === 'xferGet') {
        const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (code.length !== 6) return res.status(400).json({ error: 'code' });
        const [data] = await redis([['GET', 'xfer:' + code], ['DEL', 'xfer:' + code]]);
        if (!data) return res.status(404).json({ error: 'no_code' });
        return res.status(200).json({ ok: true, data });
      }
      if (b.action === 'name') {
        await redis([['HSET', 'lbname', b.pid, name]]);
        return res.status(200).json({ ok: true, name });
      }

      const track = String(b.track || '');
      if (!TRACKS.includes(track)) return res.status(400).json({ error: 'track' });
      const bad = plausible(b);
      if (bad) return res.status(400).json({ error: 'implausible_' + bad });
      const score = scoreOf(+b.t, +b.kills);
      const run = { t: Math.floor(+b.t), kills: +b.kills, level: +b.level, car: CARS.includes(b.car) ? b.car : 'interceptor', cleared: !!b.cleared || !!b.escaped, escaped: !!b.escaped, at: Date.now() };
      const [prev] = await redis([['ZSCORE', 'lb:' + track, b.pid]]);
      const best = prev === null || score > +prev;
      const cmds = [['HSET', 'lbname', b.pid, name]];
      if (best) cmds.push(['ZADD', 'lb:' + track, score, b.pid], ['HSET', 'lbrun:' + track, b.pid, JSON.stringify(run)]);
      cmds.push(['ZREVRANK', 'lb:' + track, b.pid], ['ZCARD', 'lb:' + track]);
      const out = await redis(cmds);
      return res.status(200).json({ ok: true, best, rank: out[out.length - 2] + 1, total: out[out.length - 1] });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(502).json({ error: 'storage' });
  }
};

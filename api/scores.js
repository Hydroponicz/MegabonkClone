// Online leaderboard for Carnage Loop: a Vercel serverless function backed by Upstash Redis (REST API, no npm packages).
//
//   GET  /api/scores?track=yard[&limit=50]       top runs on a track; send the x-player header to also get your own rank
//   POST /api/scores {pid,name,track,t,kills,level,car,cleared}   submit a run (kept only if it beats your best on that track)
//   POST /api/scores {pid,name,action:'name'}    change your display name everywhere
//
// Ranking: longest survival time, then most wrecks. Player ids are random secrets made by the game and are never returned.
// Storage: lb:<track> sorted set (pid -> score), lbrun:<track> hash (pid -> run JSON), lbname hash (pid -> name).

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
const CARS = ['interceptor', 'dozer', 'hornet', 'pyro', 'volt', 'junker'];
const MAX_T = 4 * 3600;

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
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}

// a few sanity limits a real run can't exceed; this stops typos and casual tampering, not a determined cheater
function plausible(b) {
  const t = +b.t, k = +b.kills, l = +b.level;
  if (!(t >= 10 && t <= MAX_T)) return 'time';
  if (!(Number.isInteger(k) && k >= 0 && k <= 40 + t * 12)) return 'kills';
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
      const limit = Math.max(1, Math.min(100, +req.query.limit || 50));
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

      if (b.action === 'name') {
        await redis([['HSET', 'lbname', b.pid, name]]);
        return res.status(200).json({ ok: true, name });
      }

      const track = String(b.track || '');
      if (!TRACKS.includes(track)) return res.status(400).json({ error: 'track' });
      const bad = plausible(b);
      if (bad) return res.status(400).json({ error: 'implausible_' + bad });
      const score = scoreOf(+b.t, +b.kills);
      const run = { t: Math.floor(+b.t), kills: +b.kills, level: +b.level, car: CARS.includes(b.car) ? b.car : 'interceptor', cleared: !!b.cleared, at: Date.now() };
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

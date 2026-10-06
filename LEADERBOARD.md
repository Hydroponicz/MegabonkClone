# Online leaderboard

The game posts each player's best run per track to `/api/scores`. This is a
Vercel serverless function in `api/scores.js` that keeps scores in an Upstash
Redis database. The function has no npm dependencies.

## One-time setup (Vercel dashboard)

1. Open the **vibecodingmegabonkclone** project on vercel.com and go to **Storage**.
2. Choose **Create Database**, pick **Upstash** (Redis), and accept the free plan.
3. Connect it to this project for both the **Production** and **Preview** environments.
   Vercel then adds the `KV_REST_API_URL` and `KV_REST_API_TOKEN` environment variables.
   The `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` names also work.
4. Redeploy. Environment variables only reach deployments made after they were added.

## Checking the connection

Open `/api/scores?diag=1` on the deployed site. It shows which environment the
deployment is (`production` or `preview`), whether credentials were found, a
`PING` to the database, and the names (never the values) of any `KV`, `REDIS`
or `UPSTASH` variables the function can see. Prefixed names such as
`STORAGE_KV_REST_API_URL` are picked up automatically.

Until the database is connected, `/api/scores` answers `503 not_configured`.
The game says the leaderboard isn't set up yet and keeps each player's best
runs on their device, then uploads them once the server works.

## How it works

- **Ranking:** a run is ranked by the longest survival time on a track, with the
  most wrecks as the tie-break. Only a player's best run per track is kept.
  Runs shorter than 10 seconds aren't posted.
- **Players:** each browser makes a random 32-hex player id, stored in
  localStorage. The id is never shown or returned by the API. Names are 2–16
  letters, numbers, spaces, `.`, `_` or `-`, and players can change them on the
  Leaderboards screen.
- **Data stored:**
  - `lb:<track>` sorted set (player id → score)
  - `lbrun:<track>` hash (run details: time, wrecks, level, car, cleared, date)
  - `lbname` hash (display names)
  - `rl:<ip>` counter that expires after 60 seconds, used for rate limiting
    (30 posts per minute per address)
  - `xfer:<code>` an exported save parked for **Settings › Transfer save**. It
    expires after 15 minutes and is deleted the first time the code is used.
- **Cheating:** the server rejects impossible runs (time, wreck rate and level
  limits). The game runs entirely in the browser, though, so someone who
  edits it can still post a fake score. Stopping that would need server-side
  replay checks. If needed, remove a bad entry with
  `ZREM lb:<track> <id>` in the Upstash console.
- **Privacy (for store listings):** the leaderboard stores the chosen display
  name, the random player id and run stats. IP addresses are only held for
  60 seconds by the rate limiter.

## Save transfer

Settings › Transfer save moves a player's progress (unlocks, garage, scrap,
stats, achievements and leaderboard identity) to another device. It can use a
6-character code that lasts 15 minutes and works once, which needs the database
above. It can also use a save text or file, which works with no server at all.
Loading a save replaces that device's progress after a confirmation step.
Device settings such as volume are not transferred.

# Shop, ads and premium currency

The game has a monetization framework that you can play end to end today with
placeholder ads and free test purchases. Real ad networks and payments plug in
later without changing the game loop.

## What players see

- **Shop** (main menu). The button shows **Free chest** when the daily chest is
  ready; otherwise it shows the player's crystal balance.
  - **Daily chest:** free once per UTC day. It contains 150–400 scrap, with a
    chance of Nitro Crystals, a paint job, or driver XP.
  - **Sponsor chest:** opened by watching a rewarded ad. It contains 80–200
    scrap and a chance of crystals. Players get 3 per day, 5 minutes apart.
  - **Vehicle skins:** 12 cosmetic skins bought with **Nitro Crystals**, the
    premium currency. Prices run from 120 to 1,200 crystals. A skin works on
    every car and covers any paint job.
  - **Crystal packs:** 100 / 550 / 1,200 / 2,600 crystals, priced
    $0.99–$19.99 when live.
- **In the run:**
  - **Ad revive:** once per run, when the car is wrecked, the player is offered
    an ad to come back with 50% HP. The offer goes away by itself after 8
    seconds.
  - **Double scrap:** the after-action report offers an ad to double the scrap
    banked from that run.
  - **Interstitials:** an ad between runs is built in but switched off
    (`ADS_CFG.interstitialEvery: 0`).

Skins and paint jobs are cosmetic. Nothing bought with crystals changes how a
car drives.

## Test mode (the default)

In test mode:

- Ads are a built-in **placeholder**: a full-screen card with a 5-second
  countdown. Watching to the end earns the reward; *Skip* doesn't.
- Crystal packs are **free**. A confirm dialog says "TEST PURCHASE" and no
  money is involved.
- The Shop shows a striped **TEST MODE** bar with a **Reset test limits**
  button. It clears the daily chest and the ad-chest limit and cooldown, so you
  can test them again straight away.

The wallet runs in one of two ways, picked automatically:

| Where the game runs | Wallet |
|---|---|
| A Vercel deployment whose Upstash database is connected (same setup as the leaderboard, see `LEADERBOARD.md`) | **Server wallet** in `api/shop.js`. Crystals, owned skins and chest timers live on the server, keyed by the player's recovery code, so they follow transfers and restores. |
| Opened as a local file, or a deployment without the database | **Local test wallet** kept in the save. It has the same rules and odds as the server. |

The test bar says which wallet is in use.

## Backend: `api/shop.js`

All calls are `POST /api/shop` with a JSON body `{key, action, ...}`. `key` is
the player's 12-character recovery code, which the game already creates for
cloud backups.

| action | extra fields | what it does |
|---|---|---|
| `state` | | Returns the wallet, owned skins, chest timers and `test` (true in test mode) |
| `daily` | | Opens today's free chest. Returns `reward` and adds any crystals |
| `adchest` | `adToken` | Opens a sponsor chest. Limited to 3 a day with a 5-minute cooldown. Needs a verified ad view when live |
| `purchase` | `sku`, `receipt` | Adds the pack's crystals. Needs a verified payment when live |
| `buyskin` | `skin` | Spends crystals on a skin. The server's price list is the one that counts |
| `testreset` | | Test mode only: clears the chest timers and ad limits |

- **Chest rolls:** chest contents are rolled on the server. Crystals are
  credited there; scrap, paint jobs and driver XP are applied to the save by
  the game.
- **Storage:** `wallet:<sha256(key)>` hash, kept for two years. There's also a
  per-address rate limit.
- **Catalogue:** keep the prices in `SKINS` and `PACKS` in sync between
  `api/shop.js` and `index.html`.

## Going live

Live mode is switched on by **`SHOP_LIVE=1`** in the Vercel project's
environment variables. Once it is set:

- free purchases, unverified sponsor chests and `testreset` are refused;
- the TEST MODE bar disappears.

Before you set it, do the following.

### 1. Ads (client)

Ad settings live in `ADS_CFG`, near the top of the monetization code in
`index.html`. With the default `provider: 'auto'`, the game picks the ad
provider from where it is running.

**Your own website: Google H5 Games Ads.**

1. Get the site approved in AdSense. A custom domain is usually needed.
2. Paste your publisher id: `adsenseClient: 'ca-pub-…'`.
3. Put AdSense's line in `ads.txt` at the site root. The file is already there
   with instructions.
4. Turn on AdSense's GDPR consent message (Privacy & messaging).
5. Test with `adsenseTest: true`, which shows Google's test ads. Set it to
   `false` once you're approved.

The game loads Google's script itself. It asks Google whether a rewarded ad is
ready before offering one, so an empty ad slot never shows a dead button.

**CrazyGames and Poki.** Nothing to set. On their domains the game loads the
portal's SDK, uses its rewarded ads and its between-run ads (portals expect
one), sends the "gameplay started/stopped" signals they ask for, and hides
crystal packs, which portals don't allow. To try a portal's SDK in its own
test mode, add `?portal=poki` or `?portal=crazygames` to the game's URL. The
leaderboard and shop still reach your server, because the game calls
`API_HOME` by its full address when it's served from elsewhere, and both APIs
allow cross-site requests.

**Ad blockers.** If an ad SDK can't load, the ad offers simply stay hidden and
the game plays on.

**Mobile apps.** An AdMob adapter is needed (see `STORES.md`). Until then the
app build uses the placeholder.

### All ages

The game is for everyone, including under-13s. In practice that means:

- **Ads:** `ADS_CFG.kidSafe` is on, so Google is asked for non-personalised ads only (`requestNonPersonalizedAds`).
  If AdSense offers child-directed tagging for the site, turn it on too.
- **Leaderboard names:** generated from word lists, never typed.
- **Purchases:** real-money crystal packs sit behind a grown-up check (a times-table question).
- **Policy:** `privacy.html` describes all of this.

The portals run their own ad settings for young players.

### 2. Ad verification (server)

`verifyAd(token)` in `api/shop.js` is where server-side verification (SSV)
goes, for networks that support it. In live mode, an unverified sponsor chest
still opens but pays **scrap only, no crystals**. Google H5 Games Ads and the
portals don't offer SSV, so this is how sponsor chests work with them. The
in-run revive and double-scrap rewards only touch the local save, so they don't
need the server.

### 3. Payments (server)

Fill in `verifyPurchase(sku, receipt)` in `api/shop.js`, or credit crystals from
a payment webhook instead. On the web, the usual setup is **Stripe Checkout**:

1. The shop calls a new endpoint that creates a Checkout session for the pack.
   It puts the player's key in the session metadata.
2. The player pays on Stripe's page.
3. Stripe calls a webhook (for example `api/stripe-webhook.js`, with its
   signature checked against your webhook secret).
4. The webhook adds the pack's crystals to `wallet:<sha256(key)>`.

Then change the pack button so it goes to Checkout instead of the test confirm
dialog.

### 4. Before launch

- **Policies:** `privacy.html` is a draft privacy policy written around what
  the game actually stores. It's linked from the main menu and Settings. Fill
  in the bracketed name and contact email and have it reviewed. Terms of sale,
  including a refund policy for crystals, are still needed.
- **EU/UK ad consent:** turn on AdSense's consent message. Google uses it even
  for non-personalised ads, for cookies used in measurement and fraud
  prevention.
- **Store labels:** check age-rating and loot-box rules for the regions you
  ship to. Chest odds are listed in `rollChest` if you need to publish them.

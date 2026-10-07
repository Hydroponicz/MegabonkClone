# Putting Carnage Loop on Google Play and the App Store

The game is a single web page. The way to ship it as a phone app is to wrap it in
a native shell that shows the page full screen and gives it access to native
features: store payments, native ads and the back button.

## Recommended: Capacitor (one project, both stores)

[Capacitor](https://capacitorjs.com) packages `index.html` as a real Android and
iOS app. It has plugins for **AdMob** ads and **in-app purchases**, which the
stores require.

The game is already prepared for it:

- **Server address:** inside the app it calls your server by its full address
  (`API_HOME` in `index.html`), and both APIs accept requests from the app.
- **Purchases:** crystal packs are hidden in the app build until store
  purchases are wired in, because Apple and Google don't allow other payment
  methods for digital items.
- **Phones:** touch controls, safe-area insets and the phone HUD already exist.

### What you need

| | Google Play | Apple App Store |
|---|---|---|
| Developer account | Google Play Console, $25 once | Apple Developer Program, $99 a year |
| Build machine | Any computer with Android Studio | A **Mac** with Xcode, or a cloud Mac service such as Codemagic or Ionic Appflow |
| Review time | Usually hours to a few days. New personal accounts must run a closed test with testers first. | Usually 1–3 days |

### Steps

1. **Create the app project** (on your computer, in the repo folder, with Node.js installed):
   ```sh
   npm init -y
   npm i @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios @capacitor/app
   npx cap init "Carnage Loop" com.yourstudio.carnageloop --web-dir=www
   mkdir -p www && cp index.html privacy.html www/
   npx cap add android
   npx cap add ios          # on a Mac
   npx cap sync
   ```
   After every game change, run the `cp` and `npx cap sync` lines again.
2. **Run it on a phone:** `npx cap open android` (Android Studio) or
   `npx cap open ios` (Xcode), then press Run with a phone plugged in.
3. **Icons and splash screen:** make a 1024×1024 icon, then run
   `npx @capacitor/assets generate`.
4. **Native ads (AdMob):** create an AdMob account and an app with rewarded and
   interstitial ad units, then add `@capacitor-community/admob`. The game's ad
   module needs an `'admob'` branch next to the H5, Poki and CrazyGames ones.
   AdMob also needs:
   - its consent form (UMP) for EU/UK players;
   - Apple's App Tracking Transparency prompt on iOS.
5. **In-app purchases:**
   1. Set up the crystal packs as products in App Store Connect and the Play
      Console.
   2. Use **RevenueCat** (`@revenuecat/purchases-capacitor`). It handles both
      stores, checks receipts and calls a webhook.
   3. Point that webhook at a new endpoint that adds crystals to the player's
      wallet in `api/shop.js`.
   4. Then turn the crystal packs back on for the app build.
6. **Store listings:**
   - **Privacy policy URL:** the full address of `privacy.html` on your site.
   - **Privacy forms:** Google's **Data safety** form and Apple's **App Privacy**
     labels. List the leaderboard name, the random player ID, game data, and
     the ad identifiers used by AdMob.
   - **Content rating:** the IARC questionnaire (Play) and the age rating
     questions (Apple). Declare the cartoon vehicle violence, the ads and the
     in-app purchases.
   - **Store graphics:** screenshots for phone and tablet, and a feature graphic
     (Play).
   - **Chest odds:** Apple requires the odds of "loot box" style rewards to be
     disclosed. The chests are free or ad-based, not bought, but listing the
     odds (they're in `rollChest`) is the safe choice.

### Things the app build still needs in the code

- **Android back button:** pause, or go back a screen, instead of closing the
  app. This uses the `@capacitor/app` `backButton` event.
- **Orientation:** lock it, or test both.
- **Ads and purchases:** the `'admob'` ad adapter, and store purchases via
  RevenueCat.

## Simpler alternative for Android only: a Trusted Web Activity

[PWABuilder](https://www.pwabuilder.com) or Bubblewrap can turn the website
itself into a Play Store app (a "TWA").

- **Pros:** very little setup, and the app always runs the live website.
- **Cons:** H5 web ads aren't permitted inside Play apps the way AdMob is, and
  digital purchases still have to go through Google Play Billing. There's also
  no equivalent for iOS, so you'd still need Capacitor (or PWABuilder's iOS
  package) for Apple.

## What I can and can't do from here

- **Can do:** set up the Capacitor project files, the `www` build step, the
  AdMob and store-purchase adapters, the Android back button, and the
  webhook endpoint, all in this repo.
- **Can't do:** create the store or AdMob accounts, run Xcode, sign the builds
  or upload them. Those happen on your computer and in the store dashboards.

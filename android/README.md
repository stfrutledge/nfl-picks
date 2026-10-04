# NFL Picks - Android app

A thin native shell around the live site. The site itself
(`https://stfrutledge.github.io/nfl-picks/`) runs full screen in a WebView, so
**every fix to the site reaches the app with no new APK**. The app adds the
three things a web page cannot do:

- **A picker that belongs to the phone.** Settings > *Who are you?* No login,
  the same trust the site already runs on. Before the site's own script runs,
  `MainActivity` writes that name into the site's `selectedPicker`
  localStorage key (a document-start script), so the page opens as that person
  and the site needs no change to know who it is. The site's picker dropdown
  still works for looking at someone else; the next launch goes back to the
  phone's own picker.
- **Push notifications.** Every copy of the app subscribes to one Firebase
  Cloud Messaging topic, `group`. On the admin's phone only (picker =
  Stephen), Settings has a *Message the group* box, which POSTs to the
  worker's `/notify`.
- **A clipboard that works.** The site copies through `navigator.clipboard`
  (Export All Picks, the Weekly Recap), which a WebView does not reliably
  allow. The start script routes it to the native clipboard.

- **Admin Settings.** With Stephen chosen, Settings shows one *Admin Settings* button. It asks for the admin key (checked against `admin.properties`'s hash) before it shows anything; the phone then stays unlocked until *Lock admin on this phone*. Inside: the admin tools and *Message the group*.
- **Stephen's admin actions in Settings.** *Refresh spreads from API*, *Export
  all picks* and the Odds API credits line moved off the bottom of the picks
  into an *Admin tools* card. They are still the site's own code, run on the
  page that stays open behind Settings: `PageBridge` lends Settings a way to
  run script there (`runAppAdminAction`), and the page answers through
  `NFLPicksApp.adminResult(action, ok, message, quota)`, so the result and the
  new credits count show in Admin Settings without leaving it. If Android has
  closed the page, Settings closes and runs the action there instead. The
  credits line is read off the page (`appAdminInfo`) as Settings opens.
  Cowherd's Blazin' 5 entry stays with the picks, by choice: it is weekly
  data entry tied to the week on screen.

The page sees the app as `window.NFLPicksApp` (`picker()`, `copy(text)`,
`openSettings()`, `hasAdminTools()`). The site's side is
`setupAppSettingsButton()`: the header gear shows only when that bridge
exists, and the page's admin buttons are hidden (`.app-admin-tools`) only when
`hasAdminTools()` says so. The site and the APK ship separately, so a site
change must keep working with an older app: test for a bridge method before
calling it. `node test-app-bridge.js` covers this.

## Look

- **Icon**: the NFL shield on the link preview's white-to-grey field, rendered
  by `make-icon.ps1` from the same asset as the favicon and `og-image.png`
  (launcher at every density, a monochrome layer for Android 13 themed icons,
  a white cut-out shield for notifications, and the Settings header shield).
  Re-run it if the shield ever changes:
  `powershell -ExecutionPolicy Bypass -File android/make-icon.ps1`.
- **Settings** is drawn in the site's style rather than Material's: the black
  header with the shield and the green subtitle, `--bg-secondary` page,
  bordered 8dp cards, uppercase letter-spaced labels and black uppercase
  buttons, in Inter (bundled; OFL, see `FONT-LICENSE-Inter.txt`). It follows
  the phone's light/dark setting with the site's dark tokens. On first launch
  the same screen is the welcome.

## Building

```sh
./build.sh          # signed release APK -> Downloads/NFLPicks.apk
```

The build reuses the portable JDK and SDK in `%LOCALAPPDATA%/tvremote` (from
the TV Remote and Live TV apps), and writes its output to
`%LOCALAPPDATA%/nflpicks-build`, outside OneDrive. **Bump `versionCode` in
`app/build.gradle.kts` on every release**, or phones won't install it over the
top.

Not in git, and needed:

| File | What |
|---|---|
| `release.jks` + `keystore.properties` | The signing key. **Keep a copy.** An APK signed with a different key will not install over the old one, so everyone would have to uninstall first. |
| `admin.properties` | `adminKeySha256=` the SHA-256 of the admin key (`NOTIFY_SECRET`). Admin Settings opens only for a key that hashes to it, so anyone who picks Stephen (there are no logins) cannot open it. The hash ships in the APK; the key never does. Without the file, any key opens the page and the worker is the only check. |
| `firebase.properties` | The Firebase project's Android app config (below). Without it the app builds and works, but has no notifications. |
| `local.properties` | `sdk.dir`, copied from the Live TV app. |

## Setting up notifications (once)

### 1. Firebase project

1. https://console.firebase.google.com > **Create a project** (any name, e.g.
   *NFL Picks*). Google Analytics is not needed.
2. **Add app** > Android. Package name **`com.sfrut.nflpicks`**. Skip the
   SDK steps.
3. Download `google-services.json`. The four values the app needs are in it.
   Write them to `android/firebase.properties`:

   ```properties
   apiKey=<client[0].api_key[0].current_key>
   appId=<client[0].client_info.mobilesdk_app_id>
   projectId=<project_info.project_id>
   senderId=<project_info.project_number>
   ```

4. Rebuild with `./build.sh`.

### 2. A key the worker can send with

Firebase console > Project settings > **Service accounts** > **Generate new
private key**. That downloads a JSON file. It is the credential for sending to
every phone: keep it out of the repo, and delete the local copy once it is in
the worker.

### 3. The worker

The worker's `/notify` is in `cloudflare-worker/nfl-picks-proxy.js`. Paste the
file into the Cloudflare dashboard as usual (see `cloudflare-worker/README.md`),
then add two encrypted variables:

| Variable | Value |
|---|---|
| `FCM_SERVICE_ACCOUNT` | the whole service-account JSON from step 2 |
| `NOTIFY_SECRET` | any long random string: the admin key |

### 4. The admin's phone

Settings > *Message the group* > **Admin key** = the `NOTIFY_SECRET` value. It
stays on that phone. It is never built into the APK, which everyone gets.

## Installing

Send `NFLPicks.apk` in WhatsApp. On the phone: open it, allow *Install unknown
apps* for WhatsApp (or Files) when Android asks, and install. On first launch
the app asks who you are, then asks to allow notifications.

## Tests

`node test-worker-notify.js` (repo root) runs `/notify` against a fake Google:
it refuses without the secret, and signs and sends properly with it.

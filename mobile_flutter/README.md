# Quotes Journal — mobile app

The Flutter client for the Quotes Journal Worker. It talks to the same HTTP API
the web app uses, so it needs a deployed (or locally running) Worker to point at.

## Configure the backend

The server address is a compile-time constant, so release builds cannot be
pointed at the wrong host by accident. It defaults to production
(`https://quotes.huelin.dev`), so a release build needs no flag:

```bash
flutter build apk
flutter build ipa
```

Override it to run against a local Worker:

```bash
flutter run --dart-define=QUOTES_JOURNAL_URL=http://10.0.2.2:8787   # Android emulator against `npm run dev`
flutter run --dart-define=QUOTES_JOURNAL_URL=http://localhost:8787  # iOS simulator
```

## Develop

```bash
flutter pub get
flutter analyze
flutter test
```

## What the app does

- Create an account or sign in; the session token is held in memory for the run.
- List the groups you belong to, create a group, or join one from an invite link.
  If the group already has someone using your display name, it asks what to call
  you there rather than turning you away.
- Record a quote: pick who said it and who else was there. The server attributes
  the quote to you, so who collected what cannot be faked.
- While the year runs, only a count is visible, and the group opens on the quote
  form. From 1 January collecting is over: the form is gone and the group opens
  on the reveal, with every quote and the per-member statistics.
- Owners can add a guest, bind a guest to the account of someone who has joined,
  and rename or remove a member. Those routes are owner-only on the server, so
  the app only offers them to owners.

## Identifiers

Both are **permanent once published**. Neither store lets you change the id of a
released app; a different id is a different app, with a separate listing and no
upgrade path for anyone who installed the old one.

| Platform | Identifier |
| --- | --- |
| Android | `dev.huelin.quotesjournal` |
| iOS | `dev.huelin.quotesjournal` |

## Release builds

### Android

Generate an upload keystore **once**, and keep it somewhere you will still have
in five years:

```bash
keytool -genkey -v -keystore ~/quotes-journal-upload.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

Losing this file means you can never ship an update to the published app again.
Play matches uploads by signing key and there is no recovery. Back it up
somewhere other than this repository — `android/.gitignore` deliberately
excludes `key.properties`, `*.jks` and `*.keystore`.

Then `cp android/key.properties.example android/key.properties`, fill it in, and:

```bash
flutter build appbundle --release    # build/app/outputs/bundle/release/app-release.aab
```

Without signing configured the build **fails** rather than quietly producing a
debug-signed bundle that Play would reject on upload.

### iOS

Needs a Mac with Xcode — there is no way around this, Apple does not support
building or submitting from Linux.

```bash
flutter build ipa --release          # build/ios/ipa/
```

Then submit the `.ipa` with Xcode's Organizer or Transporter.

### On a tag

`.github/workflows/mobile-release.yml` builds both on `git push --tags` for a
`v*` tag, and attaches the Android bundle to the workflow run. Nothing is
uploaded to either store automatically, so tagging can never publish by itself.

The Android job needs four repository secrets:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 quotes-journal-upload.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | `upload` |
| `ANDROID_KEY_PASSWORD` | key password |

The iOS job builds **unsigned**: a submittable archive needs an Apple
distribution certificate and provisioning profile installed on the runner. Until
that is set up it serves as a compile check, and the real archive comes from
Xcode.

## Submitting

You need a **Google Play developer account** (one-off fee) and an **Apple
Developer Program membership** (annual). Check current prices — they change.

Both listings need:

- **A privacy policy URL.** Served by the Worker at
  <https://quotes.huelin.dev/privacy>. Keep it accurate: the store data-safety
  answers have to match what it says.
- **A data-safety / privacy declaration.** Declare what the app actually
  collects: an **email address** and a **display name**, both tied to the user's
  identity, used for account functionality only. No analytics, no advertising,
  no tracking, no third-party sharing, no location, contacts or photos.
- **Screenshots** at the sizes each store requires, and a short description.
- Apple additionally wants a **support URL** and a **sign-in demo account**, so
  review can get past the login screen. Create a throwaway account on
  production and hand over the credentials in App Store Connect.

Apple review note: the app is a native client over an HTTP API, not a webview
wrapper, which is what guideline 4.2 (minimum functionality) exists to catch.
Expect that to be fine, but be ready to explain it if asked.

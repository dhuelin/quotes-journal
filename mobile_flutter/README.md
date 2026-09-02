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

## Store submission

Signing config, bundle ids and store metadata are not set up yet — see the
open issues on the repository.

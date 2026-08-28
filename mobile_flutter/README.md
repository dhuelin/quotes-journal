# Quotes Journal — mobile app

The Flutter client for the Quotes Journal Worker. It talks to the same HTTP API
the web app uses, so it needs a deployed (or locally running) Worker to point at.

## Configure the backend

The server address is a compile-time constant, so release builds cannot be
pointed at the wrong host by accident:

```bash
flutter run --dart-define=QUOTES_JOURNAL_URL=http://10.0.2.2:8787          # Android emulator against `npm run dev`
flutter build apk --dart-define=QUOTES_JOURNAL_URL=https://<worker>.workers.dev
flutter build ipa --dart-define=QUOTES_JOURNAL_URL=https://<worker>.workers.dev
```

Without the flag it falls back to `https://quotes-journal.example.workers.dev`,
which is a placeholder and will not resolve.

## Develop

```bash
flutter pub get
flutter analyze
flutter test
```

## What the app does

- Create an account or sign in; the session token is held in memory for the run.
- List the groups you belong to, create a group, or join one from an invite link.
- Record a quote: pick who said it and who else was there. The server attributes
  the quote to you, so who collected what cannot be faked.
- While the year runs, only a count is visible. From 1 January the reveal tab
  shows every quote and the per-member statistics.

## Store submission

Signing config, bundle ids and store metadata are not set up yet — see the
open issues on the repository.

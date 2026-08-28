# Planned issues

Ready-to-file issue drafts for the work that is still open. Each one is written
so another agent can pick it up without reading the rest of this document.

They live here because the tooling that wrote them could not reach the GitHub
issue API. **Once these are filed as real issues, delete this file** — the
tracker is the source of truth, not the repository.

---

## 1. Build the interactive Kahoot-style quiz frontend

**Context.** `GET /api/groups/:groupId/quiz` already returns a quiz payload once
the group unlocks on 1 January: an array of
`{ quoteId, quote, answerMemberId, options }`, where `options` is every member of
the group. Nothing consumes it yet — neither the web app (`src/ui.ts`) nor the
Flutter app (`mobile_flutter/`). This is the biggest remaining gap against the
original brief: "the application should prepare a quiz in the style of Kahoot to
guess which users said which quote".

**What to build.** A playable quiz on top of the existing payload:

- One question at a time: the quote, then the members as answer buttons.
- Scoring, ideally with a time component like Kahoot (a faster correct answer
  scores more).
- A short reveal of the correct answer between rounds.
- A final leaderboard for the session.

**Decision to make.** The payload is currently single-player and client-scored:
it ships `answerMemberId` to the client, so a player can read the answers out of
the network tab. Pick one:

1. *Honest-but-cheatable* — fine if the group plays together on one screen. No
   server changes.
2. *Server-scored rounds* — strip `answerMemberId` from the payload and add an
   endpoint that takes a guess and returns correct/incorrect plus a score.
   Needs per-player quiz state. Good middle ground.
3. *Multiplayer, host screen plus phones* — a quiz-session Durable Object holding
   the round pointer and every player's score, with polling or WebSockets. The
   real Kahoot experience, and by far the most work.

**Notes.** A group with only two members makes for a trivial quiz; consider
requiring at least three, or padding the options. `buildQuiz` in `src/domain.ts`
shapes the payload and is covered by `test/domain.test.ts`.

**Acceptance.** A member can play the quiz from the web app after the reveal;
scoring has unit tests; round transitions have integration tests; if the payload
shape changes, `test/api.integration.test.ts` is updated with it.

---

## 2. Make the reveal timezone-aware

**Context.** `getRevealAtIso` in `src/domain.ts` unlocks a group at
`Date.UTC(revealYear + 1, 0, 1)` — midnight **UTC**. For a group in Berlin the
vault opens at 01:00 on 1 January; for one in Los Angeles it opens at 16:00 on
31 December, which is the wrong side of the year boundary and would spoil a New
Year's Eve reveal.

**What to build.**

- Store an IANA timezone on the group (chosen at creation, defaulting to the
  creator's `Intl.DateTimeFormat().resolvedOptions().timeZone`).
- Compute the reveal instant from that zone rather than from UTC.
- Show the local reveal time in both clients, not just a day count.

**Notes.** `Intl` with `timeZone` is available in workerd, so the offset can be
resolved without a date library. Existing groups have no timezone field —
default them to UTC so behaviour does not change under anyone.

**Acceptance.** Unit tests cover a zone ahead of UTC, a zone behind it, and the
exact boundary second on both sides. `test/api.integration.test.ts` covers a
group created in a non-UTC zone.

---

## 3. Add a countdown and unlock notifications

**Context.** The web app shows "N days to go" and nothing else happens on
1 January — a group has to remember to come back. There is currently no
scheduled work in the Worker at all.

**What to build.**

- A Cloudflare Cron Trigger (`[triggers] crontabs` in `wrangler.toml`, plus a
  `scheduled` handler) that runs at the turn of the year.
- Email or push notification to every member of a group whose reveal has just
  landed. Email needs a provider binding; push needs the PWA push flow and
  per-device subscriptions.
- Optional: a reminder partway through the year to groups that have gone quiet.

**Notes.** A Durable Object alarm per group is the alternative to a global cron
and scales better than scanning every group — but there is no group index today,
so an alarm set at creation time is probably the simpler route.

**Acceptance.** The scheduled handler is unit tested with a fake clock; sending
is behind an interface so tests do not send anything.

---

## 4. Analytics beyond the leaderboard

**Context.** `buildStats` returns totals per member: quotes said, quotes
collected. The reveal shows them as a flat table.

**What to build.** Richer views, all derivable from data already stored:

- Quotes per month across the year (the `createdAt` on every quote).
- Who collects quotes about whom — a pairing matrix from `involvedMemberIds`.
- Longest and shortest quote, busiest week, first and last quote of the year.
- Charts rather than a table.

**Notes.** Keep the aggregation in `src/domain.ts` as pure functions over
`GroupState` so it stays unit-testable, and keep it behind the reveal lock —
these are spoilers.

**Acceptance.** Each aggregate has unit tests including empty-group and
single-member cases.

---

## 5. Session revocation and account recovery

**Context.** Sessions are stateless HMAC tokens (`src/auth.ts`) valid for 30
days. There is no way to sign out other devices, and no password reset: a
forgotten password means a lost account. The only blunt instrument is rotating
`AUTH_SECRET`, which signs everyone out and invalidates every invite link.

**What to build.**

- A per-account token version stored on the `UserStore` object, included in the
  token payload and checked on verification. Bumping it revokes that account's
  sessions and nothing else.
- "Sign out everywhere" in both clients.
- Password reset by emailed one-time link (needs the same email provider as
  issue 3).
- Password change for a signed-in user.

**Acceptance.** Unit tests for version mismatch; integration test that a bumped
version rejects a previously working token.

---

## 6. Persist the mobile session across app restarts

**Context.** `QuotesApi.token` in `mobile_flutter/lib/api.dart` lives in memory
only, so the Flutter app asks for a password on every cold start. The web app
keeps its token in `localStorage`.

**What to build.** Store the token in the platform keychain
(`flutter_secure_storage`, not `shared_preferences` — it is a credential),
restore it at startup, and clear it on sign-out or a 401.

**Notes.** The app currently has no dependency beyond `cupertino_icons`; this is
the first one that needs platform channels, so check both an Android and an iOS
build after adding it.

**Acceptance.** Widget test with a fake storage backend covering restore, clear
on sign-out, and clear on a 401 from the server.

---

## 7. Set up store submission for the mobile app

**Context.** `mobile_flutter/` still carries generated defaults: the Android
application id is `com.example.mobile_flutter`, there is no signing config, and
no store metadata. It cannot be submitted to either store as it stands.

**What to build.**

- Real bundle identifiers on both platforms (`com.dhuelin.quotesjournal` matches
  what the removed Capacitor project used).
- Android signing config reading from a keystore and `key.properties` that stays
  out of git; an iOS provisioning profile.
- App icons and launch screens using the journal mark from `/icon.svg`.
- Store listing text, screenshots and privacy declarations. Note both stores now
  require a data-safety declaration: the app collects an email address and a
  display name.
- Optionally a release workflow that builds an `.aab` and an `.ipa` on tag.

**Acceptance.** `flutter build appbundle` and `flutter build ipa` both succeed
from a clean checkout with the documented secrets in place.

---

## 8. Keep the cached group name on an account in sync

**Context.** `UserStore` caches `{ groupId, name, revealYear, role }` per
membership so the group list needs one read instead of one per group
(`src/user-store.ts`). Nothing renames a group today, so the cache cannot go
stale — but the moment a rename lands, every member's list shows the old name.

**What to build.** Either implement the rename with a fan-out that updates each
member's cached copy, or drop the cache and read the groups themselves. Decide
before adding a rename feature, not after.

**Notes.** There is a related gap: joining a group writes to the group object and
then to the account object as two separate operations. If the second fails the
user is a member but the group is missing from their list. A repair path — "add a
group I am already a member of to my list" — would cover both this and any
future drift.

**Acceptance.** Integration test that a rename is visible to a second member's
group list.

# quotes-journal

Collect the funny things your friends say all year, then unlock the whole
collection — plus a quiz and per-person statistics — on 1 January.

Live at **https://quotes.huelin.dev**. A Cloudflare Worker serves both the web
app and the HTTP API; a Flutter app talks to the same API on Android and iOS.

## How it works

- **Groups.** You create a group and invite friends with a signed link. A member
  is either a linked account or a guest added by name, so friends who never sign
  up can still be quoted.
- **Collecting.** Anyone in the group records a quote: the text, who said it and
  who else was there. The server attributes the quote to whoever is signed in,
  so who collected what cannot be faked.
- **The lock.** Quotes, the quiz and the statistics all return `423 Locked`
  until midnight UTC on 1 January of the following year. During the year the app
  shows only a count, so nothing is spoiled — not even for the person who wrote
  the quote down.
- **The reveal.** From 1 January the group can read every quote, see the
  statistics (how many quotes each person said, and how many each person
  collected) and pull a Kahoot-style quiz payload.

## Security model

- Passwords are hashed with PBKDF2-HMAC-SHA256; sessions are stateless
  HMAC-signed bearer tokens valid for 30 days.
- Every group route requires membership. A non-member gets `404`, not `403`, so
  group ids cannot be probed.
- Invite codes are signed, carry a version number and expire after 7 days;
  rotating the link invalidates every code issued before. They travel in the URL
  fragment (`/join#invite=…`), which browsers never send to a server, so they
  stay out of access logs, referrers and proxies.
- Joining a group always creates a new member row. A display name matching an
  existing guest is never merged automatically — the owner binds a guest to an
  account explicitly, because only a human knows whether the new arrival really
  is that person. Names are unique within a group so the member list stays
  unambiguous; a joiner whose name is taken picks another for that group.
- Adding, renaming and removing members is owner-only, so a name cannot be
  squatted to keep someone out.
- Authentication is rate limited per client IP and per email address. The
  second bucket matters because `cf-connecting-ip` is only trustworthy behind
  the Cloudflare edge — under `wrangler dev` the client sets it. A token is
  spent only when an attempt **fails**, and login and registration have separate
  budgets, so signing in correctly on several devices never locks you out and a
  registration probe cannot deny someone their login. Writes and authenticated
  reads are limited per account.
- Every body is size- and shape-checked before it reaches storage, and a group
  is refused new quotes before it can outgrow the Durable Object value ceiling.
- The app shell is served with a strict `Content-Security-Policy`
  (`default-src 'none'`, a per-response nonce for the one inline script and
  style), plus `nosniff`, `no-referrer`, `frame-ancestors 'none'` and HSTS.

### PBKDF2 cost

`PBKDF2_ITERATIONS` sets the round count, defaulting to 30,000. That is below
OWASP's recommended 600,000, deliberately: 600k costs roughly 90ms of CPU and
the Workers **free** plan allows 10ms per request, so a free-tier deploy cannot
run it. On a **paid** plan set it to `600000`:

```bash
wrangler secret put PBKDF2_ITERATIONS   # or a [vars] entry
```

Raising it is safe at any time. Each stored hash records the count it was made
with, and a successful login re-hashes a password whose count is below the
configured one, so accounts upgrade themselves as people sign in.

Rotating `AUTH_SECRET` invalidates all sessions and all outstanding invite
links at once.

One gap is known and open: registering with an address that already has an
account answers `409`, which tells an attacker whether a given person uses the
app. Closing it properly means a neutral response with the outcome delivered by
email, which is tracked in issue #6.

## Tech stack

- Cloudflare Workers + Durable Objects (one object per group, per account and
  per rate-limit bucket)
- Hono for routing
- Vitest with the Cloudflare workers pool for unit and integration tests
- Flutter for the mobile app
- GitHub Actions for CI and Wrangler deployment
- Docker for a containerised local run

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then put a long random string in it
npm run dev
```

`AUTH_SECRET` is required. Without it the auth endpoints answer `503`.

## Test

```bash
npm test
npm run typecheck
```

## Run with Docker

```bash
docker build -t quotes-journal .
docker run --rm -p 8787:8787 -e AUTH_SECRET="a long random string" quotes-journal
```

## Mobile app

The Flutter client lives in [`mobile_flutter/`](mobile_flutter/README.md):

```bash
cd mobile_flutter
flutter pub get
flutter test
flutter run --dart-define=QUOTES_JOURNAL_URL=https://<your-worker>.workers.dev
```

The backend address is a compile-time constant, so a release build cannot be
pointed at the wrong host by accident.

## Deploy

Pushing to `main` deploys to **https://quotes.huelin.dev** via GitHub Actions.

Configure these repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The token needs, on the account holding the Worker:

- **Workers Scripts → Edit** — uploads the script, applies the Durable Object
  migrations, and stores secrets
- **Account Settings → Read**
- **User Details → Read**

and, because the Worker runs on a custom domain rather than `workers.dev`:

- **Zone → Workers Routes → Edit**, on the `huelin.dev` zone

Set the app secret once, against the same account:

```bash
npx wrangler secret put AUTH_SECRET
```

Without it the auth endpoints answer `503`. Rotating it signs everyone out and
invalidates every outstanding invite link.

### The domain

`quotes.huelin.dev` is configured as a [Custom
Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/):
the Worker is the origin, and Cloudflare manages the DNS record and the
certificate. `workers_dev = false` keeps the app on that one hostname — served
from two origins it would split sessions, since tokens live in `localStorage`
per origin.

Both clients build invite links from their own origin, so nothing needs
updating when the hostname changes. Links shared earlier keep working: an
invite code is signed against its group, not against a host.

## API overview

All `/api/groups` and `/api/invites` routes need an `Authorization: Bearer
<token>` header from register or login.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/auth/register` | `{ displayName, email, password }` → `{ token, user }` |
| `POST` | `/api/auth/login` | `{ email, password }` → `{ token, user }` |
| `GET` | `/api/auth/me` | the account and the groups it belongs to |
| `GET` | `/api/groups` | groups you belong to |
| `POST` | `/api/groups` | `{ name, revealYear }`; the creator becomes owner |
| `GET` | `/api/groups/:groupId` | members, your role, and progress while locked |
| `POST` | `/api/groups/:groupId/members` | `{ name }`, for friends without an account; owner only |
| `POST` | `/api/groups/:groupId/members/claim` | `{ guestMemberId, memberId }`; owner only |
| `POST` | `/api/groups/:groupId/members/rename` | `{ memberId, name }`; owner only |
| `POST` | `/api/groups/:groupId/members/remove` | `{ memberId }`; owner only, refused once quoted |
| `POST` | `/api/groups/:groupId/quotes` | `{ text, saidByMemberId, involvedMemberIds }`; `409` after the reveal |
| `GET` | `/api/groups/:groupId/quotes` | `423` until the reveal |
| `GET` | `/api/groups/:groupId/quiz` | `423` until the reveal |
| `GET` | `/api/groups/:groupId/stats` | `423` until the reveal |
| `GET` | `/api/groups/:groupId/invite` | current invite code; the client builds the link |
| `POST` | `/api/groups/:groupId/invite/rotate` | owner only; invalidates old links |
| `POST` | `/api/invites/accept` | `{ inviteCode, memberName? }`; `410` if expired or rotated |

## What is still open

Tracked in [the issue tracker](https://github.com/dhuelin/quotes-journal/issues):

- [#2](https://github.com/dhuelin/quotes-journal/issues/2) the interactive Kahoot-style quiz frontend
- [#3](https://github.com/dhuelin/quotes-journal/issues/3) timezone-aware reveal (today it unlocks at midnight UTC)
- [#4](https://github.com/dhuelin/quotes-journal/issues/4) year-end countdown and unlock notifications
- [#5](https://github.com/dhuelin/quotes-journal/issues/5) richer analytics beyond the leaderboard
- [#6](https://github.com/dhuelin/quotes-journal/issues/6) session revocation and password reset
- [#7](https://github.com/dhuelin/quotes-journal/issues/7) persist the mobile session across restarts
- [#8](https://github.com/dhuelin/quotes-journal/issues/8) store submission setup for the mobile app
- [#9](https://github.com/dhuelin/quotes-journal/issues/9) keep the cached group name on an account in sync

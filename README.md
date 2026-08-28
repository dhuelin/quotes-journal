# quotes-journal

Collect the funny things your friends say all year, then unlock the whole
collection — plus a quiz and per-person statistics — on 1 January.

A Cloudflare Worker serves both the web app and the HTTP API; a Flutter app
talks to the same API on Android and iOS.

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
- Invite codes are signed and carry a version number; rotating the link
  invalidates every code issued before.
- Writes are rate limited per account and authentication per IP, and every body
  is size- and shape-checked before it reaches storage.

Rotating `AUTH_SECRET` invalidates all sessions and all outstanding invite
links at once.

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

Configure repository secrets for GitHub Actions:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Set the app secret once, against your Cloudflare account:

```bash
npx wrangler secret put AUTH_SECRET
```

Then push to `main` to trigger a deploy.

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
| `POST` | `/api/groups/:groupId/members` | `{ name }`, for friends without an account |
| `POST` | `/api/groups/:groupId/quotes` | `{ text, saidByMemberId, involvedMemberIds }` |
| `GET` | `/api/groups/:groupId/quotes` | `423` until the reveal |
| `GET` | `/api/groups/:groupId/quiz` | `423` until the reveal |
| `GET` | `/api/groups/:groupId/stats` | `423` until the reveal |
| `GET` | `/api/groups/:groupId/invite` | current invite code and link |
| `POST` | `/api/groups/:groupId/invite/rotate` | owner only; invalidates old links |
| `POST` | `/api/invites/accept` | `{ inviteCode }` |

## What is still open

Tracked as issues on the repository: the interactive quiz frontend, a year-end
countdown and unlock notifications, richer analytics, timezone-aware reveal
handling, and store submission setup for the mobile app.

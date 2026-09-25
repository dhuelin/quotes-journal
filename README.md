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
  who else was there, and optionally a picture for the context the words alone
  do not carry. The server attributes the quote to whoever is signed in, so who
  collected what cannot be faked.
- **The lock.** Quotes, their pictures, the quiz and the statistics all return `423 Locked`
  until midnight UTC on 1 January of the following year. During the year the app
  shows only a count, so nothing is spoiled — not even for the person who wrote
  the quote down.
- **The reveal.** From 1 January the group can read every quote, see the
  statistics (how many quotes each person said, and how many each person
  collected) and play the quiz.
- **The quiz.** A Kahoot-style round: one quote at a time, every member as an
  answer, twenty seconds a question. A faster right answer is worth more, and
  the group sees everyone's best round.

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
- An uploaded picture is identified by its magic number, not by the
  `content-type` it arrives with, so an SVG — an image to a browser and a script
  host to an attacker — never reaches storage or gets served back from this
  origin. Pictures are served with `nosniff` and their own
  `default-src 'none'; sandbox` policy, and are read with a bearer token rather
  than through a URL that would have to carry a credential.
- The app shell is served with a strict `Content-Security-Policy`
  (`default-src 'none'`, plus a SHA-256 hash naming the one inline script and
  the one inline style), and `nosniff`, `no-referrer`, `frame-ancestors 'none'`
  and HSTS. Hashes rather than a per-response nonce: a nonce authorises whatever
  inline block carries it, while a hash authorises exactly that text — and a
  hash is stable, which is what lets the shell be cached and opened offline.

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

### Pictures on a quote

A picture is optional and behaves like part of the quote: only group members can
read it, and only after the reveal — including the person who uploaded it.

The browser shrinks the chosen photo to 1280px on its longest edge and re-encodes
it as JPEG before uploading. That keeps it inside the 1MB cap, and re-encoding
through a canvas drops the EXIF block a camera writes, so the GPS coordinates of
where a photo was taken never leave the device.

The bytes are stored under their own key in the group's Durable Object, not in
the group value. That value is read and rewritten on every write and has a hard
~2.2MB ceiling ([#10](https://github.com/dhuelin/quotes-journal/issues/10)) —
only the picture's size and type live there. R2 would be the natural home if
this grows, and is not used today because R2 is not enabled on the account.

### Scoring the quiz

The quiz is scored on the server, and the payload no longer carries
`answerMemberId`. The reason is simple: with the answer in the payload, a score
is worth exactly as much as the honesty of whoever opened devtools — and this
app already asks people to care about a leaderboard.

The clock is the server's too. A browser asked to report its own response time
can report zero, so the server stamps when it served a question and works out
the elapsed time itself. Network latency counts against the player, which is the
same bargain Kahoot makes.

An answer is checked against the question the round is actually on, so a replayed
request cannot bank the same points twice, and a member's **best** round is kept
rather than their latest — restarting is free in a party game and must never
cost someone a score they already earned.

A group needs three members to play. With two, every question is a coin flip
between you and one other person: not a quiz made easy, a quiz that does not
work.

### Offline and the installed app

The service worker precaches the app shell, the icon and the manifest, and
serves the shell for any in-app path — so an installed app opens with no
connection, deep links included, instead of showing the browser's error page.
Quotes still need the server, and the app says so rather than claiming a group
is empty.

Nothing under `/api` is ever cached. Quotes, pictures and the account are read
with a bearer token, and a copy in Cache Storage would outlive signing out —
readable by whoever picks up the device next, and for a group still under its
reveal lock, readable early. The saving would be a round trip; the cost would be
the only guarantee this app makes.

The cache is named after a fingerprint of the client itself, so deploying a
change alters the text of `/sw.js`. That is the only thing that makes a browser
install a new worker and drop the old cache — a version baked in by hand is how
an offline app ends up serving a build from months ago.

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
flutter run                 # talks to production; --dart-define to point elsewhere
```

The backend address is a compile-time constant defaulting to production, so a
release build cannot be pointed at the wrong host by accident.

Store identifiers, signing, release builds and the submission checklist are in
[`mobile_flutter/README.md`](mobile_flutter/README.md). Both app ids are
`dev.huelin.quotesjournal` and are permanent once published.

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
| `POST` | `/api/groups/:groupId/quotes/:quoteId/image` | raw JPEG/PNG/WebP bytes; recorder only, `409` after the reveal |
| `GET` | `/api/groups/:groupId/quotes/:quoteId/image` | the picture itself; `423` until the reveal |
| `POST` | `/api/groups/:groupId/quotes/:quoteId/image/remove` | recorder only |
| `GET` | `/api/groups/:groupId/quiz` | the questions, never the answers; `423` until the reveal |
| `POST` | `/api/groups/:groupId/quiz/start` | begins a round; `409` under three members |
| `POST` | `/api/groups/:groupId/quiz/answer` | `{ quoteId, memberId }`; scores it and serves the next question |
| `GET` | `/api/groups/:groupId/quiz/scores` | every member's best round |
| `GET` | `/api/groups/:groupId/stats` | `423` until the reveal |
| `GET` | `/api/groups/:groupId/invite` | current invite code; the client builds the link |
| `POST` | `/api/groups/:groupId/invite/rotate` | owner only; invalidates old links |
| `POST` | `/api/invites/accept` | `{ inviteCode, memberName? }`; `410` if expired or rotated |

The Worker also serves the app at `/`, `/app` and `/join`, and a privacy policy
at `/privacy` — both app stores require a reachable policy URL, and the
store data-safety declarations must match what that page says.

## What is still open

Tracked in [the issue tracker](https://github.com/dhuelin/quotes-journal/issues):

- [#3](https://github.com/dhuelin/quotes-journal/issues/3) timezone-aware reveal (today it unlocks at midnight UTC)
- [#4](https://github.com/dhuelin/quotes-journal/issues/4) year-end countdown and unlock notifications
- [#5](https://github.com/dhuelin/quotes-journal/issues/5) richer analytics beyond the leaderboard
- [#6](https://github.com/dhuelin/quotes-journal/issues/6) session revocation and password reset
- [#7](https://github.com/dhuelin/quotes-journal/issues/7) persist the mobile session across restarts
- [#8](https://github.com/dhuelin/quotes-journal/issues/8) store submission setup for the mobile app
- [#9](https://github.com/dhuelin/quotes-journal/issues/9) keep the cached group name on an account in sync
- [#15](https://github.com/dhuelin/quotes-journal/issues/15) a configurable reveal date, not just the year
- [#17](https://github.com/dhuelin/quotes-journal/issues/17) settings pages for accounts and groups
- [#19](https://github.com/dhuelin/quotes-journal/issues/19) publishing to the app stores (low priority)
- [#20](https://github.com/dhuelin/quotes-journal/issues/20) the Flutter client shows no quote pictures

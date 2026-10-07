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
  do not carry. A quote can be an exchange — several lines, each with its own
  speaker — so a back-and-forth stays one thing. The server attributes the quote
  to whoever is signed in, so who collected what cannot be faked.
- **The lock.** Quotes, their pictures, the quiz and the statistics all return
  `423 Locked` until the group's reveal date — midnight on 1 January by default,
  or any instant the creator picks. During the year the app shows only a count,
  so nothing is spoiled — not even for the person who wrote the quote down.
- **The reveal.** From 1 January the group can read every quote, see the
  statistics (how many quotes each person said, and how many each person
  collected) and play the quiz.
- **The quiz.** A Kahoot-style round: one quote at a time, every member as an
  answer, twenty seconds a question. A faster right answer is worth more, and
  the group sees everyone's best round.

## Security model

- Passwords are hashed with PBKDF2-HMAC-SHA256; sessions are stateless
  HMAC-signed bearer tokens valid for 30 days. Each token carries the account's
  session generation, so one account can end its own sessions without rotating
  `AUTH_SECRET` and signing out the whole deployment.
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

### Keyboard and screen readers

The whole app used to sit inside one `aria-live` region, so a screen reader
re-announced the entire page on every render — including the renders the quote
counter fires while someone is still typing. Announcements now come from a small
region outside the app that is never replaced, and carry only the notice.

The tab strips implement the **whole** ARIA tabs pattern: each tab points at a
real `tabpanel`, the panel points back, and a roving tabindex plus
arrow/Home/End keys move between them. Half a pattern was worse than none,
because `role="tab"` promises a keyboard interaction that was not there.

Focus is restored after a render. Every render replaces the document, which
dropped a keyboard user back to the top of the page each time a form was
submitted or a counter updated.

Avatar initials are `aria-hidden`: they are a visual stand-in for a picture and
the name is announced right beside them, so without it every member row read as
"A L Alice you owner".

Colour contrast was measured rather than eyeballed, and every pair passes AA for
body text — `--muted` on the three surfaces it is used on comes out at 7.75,
7.02 and 6.35 to one.

### Ending a session

A token carries the account's **token version**. Bumping the stored version
leaves every token holding an older one invalid — for that account and nobody
else. Two things bump it: "sign out all devices", and changing the password.

The version is checked on **every authenticated request**, not only on writes.
Reads are exactly where the cheaper option would fail: a leaked token that can
no longer write but can still read would still open every quote in every group
the account belongs to, which is the one thing this app exists to keep shut. The
check is a Durable Object read, issued in parallel with the rate-limit read that
every authenticated request already makes, so it costs a subrequest rather than
a round trip.

Changing the password requires the current one. A session token alone is not
enough, or a borrowed laptop would be a permanent account takeover — and a wrong
current password answers **403, not 401**, because the client signs out on a 401
and mistyping it must not log you out of the page you are standing on.

Tokens minted before versions existed carry none and read as generation zero,
which is what a never-revoked account is on — so the deploy that introduced this
signed nobody out.

### Telling a group its year is up

A group sets a **Durable Object alarm** for its own reveal instant. A cron would
have to scan every group and there is no index of them — and an alarm lands on
the minute for a group that chose an odd date, rather than whenever a sweep
happened to run.

The alarm is armed when a group is created, moved when the owner postpones, and
set on first access for any group that predates it — the same heal-on-access the
cached group name uses, and for the same reason.

The announcement says **nothing about what is inside**. A preview line on a lock
screen would hand over the ending that the whole year was spent protecting. It
is written as sent before anything goes out, so a crash halfway through a
members list cannot replay the whole list on the retry: people would rather miss
one announcement than get four.

One message per group, per year, and a switch in settings to stop even that.
Guests have no account to mail, and someone who left the group is no longer in
it in any sense that should produce mail.

### Forgetting a password

`/api/auth/forgot` answers **identically** whether or not the address has an
account, and the send happens in `waitUntil` so the response does not take
longer when there was something to send — otherwise the timing would say what
the body refuses to.

The emailed link is signed like an invite code, lives for an hour rather than a
week, and carries the account's token version. That version is what makes it
**single use**: redeeming it bumps the version, so the link stops verifying the
moment it works, and every session opened under the old password dies with it.
What is signed carries a `reset:` prefix, so an invite code — same shape, same
signer, and passed around a group chat — can never be presented as a reset link.

The token travels in the URL fragment, which browsers never send to a server,
and the client lifts it into memory and cleans the address bar on load.

One gap remains, and it is not about reset: registering with an address that
already has an account still answers `409`, which tells an attacker whether a
given person uses the app. Closing it properly means registration becoming a
two-step confirm-by-email flow, which is a real change to how signing up feels —
worth deciding deliberately rather than as a side effect.

### Profile and group pictures

Both optional, both small, both private. A profile picture is readable only by
someone who shares a group with you; a group picture only by that group's
members. Neither is ever public, and neither is addressed by a URL that carries
a credential — the client fetches with its bearer token and renders an object
URL, exactly as quote pictures do.

The bytes live under their own Durable Object key, like every other picture
here, so **no R2 bucket is involved**. That is worth stating because the issue
that asked for this assumed otherwise.

Serving one member's picture to another takes three hops, and each is a check:
the group answers only to its own members and turns a member id into an account
id; a `uid:<id>` pointer object — a second object in the existing accounts
namespace, so no new class and no migration — turns that into an address; the
account holds the bytes. Someone outside the group stops at the first hop with
the same `404` the group itself gives. The pointer is written on registration
and on every login, which also backfills accounts that predate it.

A member with no picture shows their initials, and so does a guest — a guest has
no account, so no picture can exist for them. That is the ordinary case rather
than a failure, and the client remembers which members have none so it does not
ask again on every render.

A group picture is **not** behind the reveal lock, unlike a quote's: it spoils
nothing and it is what the group looks like all year.

### Settings, and leaving a group

An account can change its display name. That name is what you are called on new
groups and on the account itself; it does **not** rename you inside groups you
are already in, because names have to stay unique within a group and a silent
bulk rename could collide with somebody else's. Renaming inside a group is the
owner's existing control. Changing the name issues a fresh session token, since
the old one carries the old name and is what names the creator of a group.

**Leaving keeps the member row as a tombstone.** Deleting it is not an option —
quotes point at it, and a group's history should not develop holes because
someone left. The row keeps its name and every quote it appears in; only the
link to the account is cut, which is what membership is checked against, so
access ends at once. The effect is a guest added by name, a shape the group
already understands.

The **owner cannot leave** while they own the group: one with nobody able to
manage members or rotate the invite is one nobody can repair. They hand it over
first, to a member with an account — a guest has no way to sign in — and stay on
as an ordinary member, because a handover is not an exit.

A group rename updates the owner's cached list immediately. Every other member's
heals the next time they open the group ([#9](https://github.com/dhuelin/quotes-journal/issues/9)):
the group object stores account ids, not addresses, and the account objects are
keyed by address, so it cannot push. Putting every member's email inside the
group value to make a push possible is a poor trade for a cached label.

### Conversations

A quote is either a single remark or an exchange of up to ten lines, each with
its own speaker. The 500-character limit is per line — a long exchange is
several ordinary remarks — and the byte budget is what actually keeps a quote
from outgrowing storage.

A quote's `text` and `saidByMemberId` always hold the opening line, mirrored,
even when `lines` carries the whole exchange. The duplication is deliberate: a
reader that predates conversations, the Flutter client included, shows the
opening line attributed to the right person rather than nothing at all.

**In the quiz**, an exchange has no single answer, so a question asks about one
line and shows the rest with their speakers named. That keeps the quiz to one
question type, and a conversation makes better material than a lone remark
precisely because the context is the joke. Each line is its own question, so a
three-line exchange is three.

**In the statistics**, every speaker in an exchange is credited once, however
many lines they have — otherwise the leaderboard would reward rambling. The
totals across members can therefore exceed the quote count, which is the honest
reading of "quotes you are in".

### The reveal date, and whether it can move

A group opens at an instant its creator picks. The default is midnight on
1 January of the following year, which is what every group did before, and a
group stored with only a year keeps deriving exactly that — so nothing shifts
under a group mid-collection and there is no migration.

The date is picked in the browser's own zone and stored as an absolute instant,
so what someone picks is what their group gets.

**The owner can push the date back, never pull it forward.** That is the rule
the product rests on: everyone who recorded a quote did so on the promise that
nobody reads it before a stated moment, and pulling that moment forward breaks a
promise they cannot take back. Delaying disappoints people; it does not betray
them. Every member sees the current date and a marker when it has moved.

Changes are refused entirely once the group has opened — re-sealing a group that
has been read would reopen collecting to people who now know what everyone else
wrote.

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

Set the app secrets once, against the same account:

```bash
npx wrangler secret put AUTH_SECRET
npx wrangler secret put BREVO_API_KEY   # optional; without it, reset is not offered
```

`BREVO_API_KEY` is a [Brevo](https://www.brevo.com) transactional-email key.
Without it `/api/auth/forgot` answers `503` and says plainly that reset is not
configured — a fact about the deployment, not about any account, so it leaks
nothing. `EMAIL_FROM` and `EMAIL_FROM_NAME` are optional `[vars]`, defaulting to
`no-reply@huelin.dev` and "Quotes Journal"; the sender address has to be one
Brevo has verified for the domain.

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
| `POST` | `/api/auth/forgot` | `{ email }`; always the same answer, mails a one-hour link |
| `POST` | `/api/auth/reset` | `{ token, newPassword }` → `{ token, user }`; the link is single use |
| `GET` | `/api/auth/me` | the account and the groups it belongs to |
| `POST` | `/api/account/display-name` | `{ displayName }` → a fresh `{ token, user }` |
| `POST` | `/api/account/notifications` | `{ notifyOnReveal }` |
| `POST` | `/api/account/password` | `{ currentPassword, newPassword }`; `403` if the current one is wrong |
| `POST` | `/api/account/sign-out-everywhere` | ends every other session, returns a fresh token |
| `POST` | `/api/account/avatar` | raw JPEG/PNG/WebP bytes, 256KB cap |
| `GET` | `/api/account/avatar` | your own picture |
| `POST` | `/api/account/avatar/remove` | |
| `GET` | `/api/groups/:groupId/members/:memberId/avatar` | a member's picture, to a member |
| `GET` | `/api/groups` | groups you belong to |
| `POST` | `/api/groups` | `{ name, revealYear, revealAt? }`; the creator becomes owner |
| `GET` | `/api/groups/:groupId` | members, your role, and progress while locked |
| `POST` | `/api/groups/:groupId/members` | `{ name }`, for friends without an account; owner only |
| `POST` | `/api/groups/:groupId/members/claim` | `{ guestMemberId, memberId }`; owner only |
| `POST` | `/api/groups/:groupId/members/rename` | `{ memberId, name }`; owner only |
| `POST` | `/api/groups/:groupId/members/remove` | `{ memberId }`; owner only, refused once quoted |
| `POST` | `/api/groups/:groupId/quotes` | `{ text, saidByMemberId }` or `{ lines: [{ text, saidByMemberId }] }`, plus `involvedMemberIds`; `409` after the reveal |
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
| `POST` | `/api/groups/:groupId/picture` | raw bytes, 512KB cap; owner only |
| `GET` | `/api/groups/:groupId/picture` | members only, not gated on the reveal |
| `POST` | `/api/groups/:groupId/picture/remove` | owner only |
| `POST` | `/api/groups/:groupId/rename` | `{ name }`; owner only |
| `POST` | `/api/groups/:groupId/leave` | keeps your member row; owners must hand over first |
| `POST` | `/api/groups/:groupId/members/transfer` | `{ memberId }`; owner only, account holders only |
| `POST` | `/api/groups/:groupId/reveal` | `{ revealAt }`; owner only, later only, refused once open |
| `POST` | `/api/groups/:groupId/invite/rotate` | owner only; invalidates old links |
| `POST` | `/api/invites/accept` | `{ inviteCode, memberName? }`; `410` if expired or rotated |

The Worker also serves the app at `/`, `/app` and `/join`, and a privacy policy
at `/privacy` — both app stores require a reachable policy URL, and the
store data-safety declarations must match what that page says.

## What is still open

Tracked in [the issue tracker](https://github.com/dhuelin/quotes-journal/issues):

- [#3](https://github.com/dhuelin/quotes-journal/issues/3) timezone-aware reveal (today it unlocks at midnight UTC)
- [#5](https://github.com/dhuelin/quotes-journal/issues/5) richer analytics beyond the leaderboard
- [#7](https://github.com/dhuelin/quotes-journal/issues/7) persist the mobile session across restarts
- [#8](https://github.com/dhuelin/quotes-journal/issues/8) store submission setup for the mobile app
- [#19](https://github.com/dhuelin/quotes-journal/issues/19) publishing to the app stores (low priority)
- [#20](https://github.com/dhuelin/quotes-journal/issues/20) the Flutter client shows no quote pictures

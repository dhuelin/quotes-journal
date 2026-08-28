# quotes-journal

A Cloudflare Worker app with web (`/`) and app-style (`/app`) interfaces to manage friend groups, collect quotes privately through the year, and unlock a quiz + statistics after year-end.

## Features

- Create friend groups with a configurable `revealYear`
- Add group members
- Save quotes (`quote`, `saidBy`, `recordedBy`, `involvedMemberIds`)
- Keep quote list and quiz locked until January 1st of the following year
- Build a Kahoot-style quiz payload (quote + answer options)
- Generate stats for:
  - how many quotes were persisted by each user
  - how many quotes were said by each user

## Tech stack

- Cloudflare Workers + Durable Objects (persistent storage)
- Hono (routing)
- Vitest + Cloudflare workers pool (unit and integration tests)
- GitHub Actions + Wrangler deployment to Cloudflare

## Local development

```bash
npm install
npm run dev
```

## Test

```bash
npm test
npm run typecheck
```

## Deploy prerequisites

Configure repository secrets for GitHub Actions:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Then push to `main` to trigger deploy.

## Suggested GitHub issue breakdown

Use these as issue titles/descriptions so other agents can pick them up quickly:

1. **Build authentication and onboarding flow**
   - Add user sign-up/login and group invitation acceptance.
   - Add tests for auth guards and membership checks.
2. **Implement richer quote capture UX**
   - Add searchable member selectors and quote tagging.
   - Add tests for quote form validation and edge cases.
3. **Create timed year-end unlock scheduler**
   - Add reminders/countdown and automated unlock notifications.
   - Add tests for boundary timestamps and timezone correctness.
4. **Build Kahoot-style interactive quiz frontend**
   - Convert quiz payload into interactive rounds, scoring, and leaderboard.
   - Add unit/integration tests for scoring logic and round transitions.
5. **Add analytics dashboards**
   - Visualize quote activity and per-user stats over time.
   - Add tests for aggregation correctness.
6. **Production hardening**
   - Add rate-limiting, input-size limits, and abuse protection.
   - Add tests for API limits and invalid payload handling.

## API overview

- `POST /api/groups` → `{ name, revealYear }`
- `POST /api/groups/:groupId/members` → `{ name }`
- `POST /api/groups/:groupId/quotes` → `{ text, saidByMemberId, recordedByMemberId, involvedMemberIds }`
- `GET /api/groups/:groupId/quotes` (locked until reveal)
- `GET /api/groups/:groupId/quiz` (locked until reveal)
- `GET /api/groups/:groupId/stats`

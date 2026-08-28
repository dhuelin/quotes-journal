import { Hono } from 'hono';
import { GroupStore } from './group-store';
import { appHtml, webHtml } from './ui';

export { GroupStore };

export type Env = {
  Bindings: {
    GROUPS: DurableObjectNamespace;
  };
};

const app = new Hono<Env>();

const jsonError = (message: string, status: number): Response =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const proxyToGroup = (groupId: string, c: { env: Env['Bindings']; req: { raw: Request } }, path: string) => {
  const durableObjectId = c.env.GROUPS.idFromName(groupId);
  const stub = c.env.GROUPS.get(durableObjectId);
  return stub.fetch(new Request(`https://group${path}`, c.req.raw));
};

app.get('/', (c) => c.html(webHtml));
app.get('/app', (c) => c.html(appHtml));

app.post('/api/groups', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return jsonError('Group name is required', 400);
  }

  const revealYear = typeof body.revealYear === 'number' ? body.revealYear : new Date().getUTCFullYear();
  if (!Number.isInteger(revealYear) || revealYear < 1970 || revealYear > 9999) {
    return jsonError('Reveal year must be an integer year between 1970 and 9999', 400);
  }

  const groupId = crypto.randomUUID();
  const durableObjectId = c.env.GROUPS.idFromName(groupId);
  const stub = c.env.GROUPS.get(durableObjectId);

  const initResponse = await stub.fetch('https://group/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: groupId, name: body.name.trim(), revealYear }),
  });

  const initBody = await initResponse.json();
  return c.json(initBody, initResponse.status as 200 | 201 | 400 | 409);
});

app.post('/api/groups/:groupId/members', (c) => proxyToGroup(c.req.param('groupId'), c, '/members'));
app.post('/api/groups/:groupId/quotes', (c) => proxyToGroup(c.req.param('groupId'), c, '/quotes'));
app.get('/api/groups/:groupId/quotes', (c) => proxyToGroup(c.req.param('groupId'), c, '/quotes'));
app.get('/api/groups/:groupId/quiz', (c) => proxyToGroup(c.req.param('groupId'), c, '/quiz'));
app.get('/api/groups/:groupId/stats', (c) => proxyToGroup(c.req.param('groupId'), c, '/stats'));

app.notFound(() => jsonError('Not found', 404));

export default app;

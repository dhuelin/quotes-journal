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

const appManifest = {
  name: 'Quotes Journal',
  short_name: 'Quotes',
  start_url: '/app',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#111111',
  icons: [
    {
      src: '/icon.svg',
      type: 'image/svg+xml',
      sizes: 'any',
      purpose: 'any maskable',
    },
  ],
};

const serviceWorkerScript = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));`;

const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Quotes Journal">
  <rect width="256" height="256" fill="#111111"/>
  <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-size="112" font-family="Arial, sans-serif">“”</text>
</svg>`;

app.get('/', (c) => c.html(webHtml));
app.get('/app', (c) => c.html(appHtml));
app.get('/manifest.webmanifest', (c) => c.json(appManifest));
app.get('/sw.js', (c) =>
  c.body(serviceWorkerScript, 200, {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'no-cache',
  }),
);
app.get('/icon.svg', (c) => c.body(appIcon, 200, { 'content-type': 'image/svg+xml; charset=utf-8' }));

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

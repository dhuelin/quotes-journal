const createHtml = (title: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#111111" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/icon.svg" />
    <title>${title}</title>
    <style>
      body { font-family: sans-serif; max-width: 900px; margin: 1rem auto; padding: 0 1rem; }
      form { margin-bottom: 1rem; padding: .75rem; border: 1px solid #ddd; border-radius: .5rem; }
      label { display:block; margin-top:.5rem; }
      input, button { padding:.4rem; margin-top:.2rem; }
      pre { background:#111; color:#eee; padding:1rem; border-radius:.5rem; overflow:auto; }
      .row { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
      @media (max-width: 640px) { .row { grid-template-columns:1fr; } }
    </style>
  </head>
  <body>
    <h1>${title}</h1>
    <p>Create a friend group, add users, save quotes, then unlock quote list + quiz after year end.</p>

    <form id="create-group">
      <strong>Create group</strong>
      <label>Name <input name="name" required /></label>
      <label>Reveal year (e.g. 2026) <input name="revealYear" type="number" required /></label>
      <button>Create</button>
    </form>

    <div class="row">
      <form id="add-member">
        <strong>Add member</strong>
        <label>Group ID <input name="groupId" required /></label>
        <label>Name <input name="name" required /></label>
        <button>Add</button>
      </form>

      <form id="add-quote">
        <strong>Add quote</strong>
        <label>Group ID <input name="groupId" required /></label>
        <label>Quote <input name="text" required /></label>
        <label>Said by member ID <input name="saidByMemberId" required /></label>
        <label>Recorded by member ID <input name="recordedByMemberId" required /></label>
        <label>Involved member IDs (comma-separated) <input name="involvedMemberIds" /></label>
        <button>Save quote</button>
      </form>
    </div>

    <div class="row">
      <form id="get-quotes">
        <strong>Get quotes</strong>
        <label>Group ID <input name="groupId" required /></label>
        <button>Load</button>
      </form>

      <form id="get-quiz">
        <strong>Get quiz</strong>
        <label>Group ID <input name="groupId" required /></label>
        <button>Load</button>
      </form>
    </div>

    <form id="get-stats">
      <strong>Get stats</strong>
      <label>Group ID <input name="groupId" required /></label>
      <button>Load</button>
    </form>

    <pre id="output">Ready</pre>

    <script>
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      }

      const output = document.getElementById('output');

      async function callApi(method, path, payload) {
        const response = await fetch(path, {
          method,
          headers: { 'content-type': 'application/json' },
          body: payload ? JSON.stringify(payload) : undefined,
        });
        const body = await response.json();
        output.textContent = JSON.stringify({ status: response.status, body }, null, 2);
      }

      document.getElementById('create-group').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        await callApi('POST', '/api/groups', {
          name: form.name.value,
          revealYear: Number(form.revealYear.value),
        });
      });

      document.getElementById('add-member').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        await callApi('POST', '/api/groups/' + encodeURIComponent(form.groupId.value) + '/members', {
          name: form.name.value,
        });
      });

      document.getElementById('add-quote').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        const involved = form.involvedMemberIds.value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);

        await callApi('POST', '/api/groups/' + encodeURIComponent(form.groupId.value) + '/quotes', {
          text: form.text.value,
          saidByMemberId: form.saidByMemberId.value,
          recordedByMemberId: form.recordedByMemberId.value,
          involvedMemberIds: involved,
        });
      });

      document.getElementById('get-quotes').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        await callApi('GET', '/api/groups/' + encodeURIComponent(form.groupId.value) + '/quotes');
      });

      document.getElementById('get-quiz').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        await callApi('GET', '/api/groups/' + encodeURIComponent(form.groupId.value) + '/quiz');
      });

      document.getElementById('get-stats').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        await callApi('GET', '/api/groups/' + encodeURIComponent(form.groupId.value) + '/stats');
      });
    </script>
  </body>
</html>`;

export const webHtml = createHtml('Quotes Journal (Web)');
export const appHtml = createHtml('Quotes Journal (App Interface)');

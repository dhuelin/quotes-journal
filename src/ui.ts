/**
 * The whole client is one document: small enough to inline, which keeps the
 * Worker a single deployable unit with no build step or asset bucket.
 */

/**
 * The style and the script are their own strings so that the CSP can name them
 * by content hash. A nonce would have done the same job, but a nonce changes on
 * every response, which makes the document uncacheable — and an app shell that
 * cannot be cached cannot work offline. A hash also says something stronger than
 * a nonce does: a nonce authorises whatever inline block carries it, while a
 * hash authorises exactly this text and nothing else.
 *
 * They are interpolated verbatim between the tags, so what the hash covers and
 * what the browser executes are the same bytes by construction.
 */
const appStyles = `
      :root {
        --bg: #0f1020;
        --surface: #191a30;
        --surface-2: #21223d;
        --line: #32345a;
        --text: #f2f2f7;
        --muted: #a2a4c4;
        --accent: #f8c630;
        --danger: #ff7b7b;
        --ok: #7bdcb5;
        color-scheme: dark;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom);
      }

      main { max-width: 720px; margin: 0 auto; padding: 1.25rem 1rem 4rem; }

      h1, h2, h3 { line-height: 1.2; margin: 0 0 .5rem; }
      h1 { font-size: 1.6rem; }
      h2 { font-size: 1.2rem; }
      h3 { font-size: 1rem; }
      p { margin: 0 0 .75rem; }

      .muted { color: var(--muted); }
      .small { font-size: .85rem; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }

      header.bar {
        display: flex; align-items: center; justify-content: space-between;
        gap: 1rem; margin-bottom: 1.25rem;
      }
      .brand { display: flex; align-items: center; gap: .6rem; font-weight: 700; }
      .brand span.mark { color: var(--accent); font: 700 1.7rem/1 Georgia, serif; }

      .card {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 1rem;
        margin-bottom: 1rem;
      }

      label { display: block; margin: .75rem 0 .25rem; font-size: .85rem; color: var(--muted); }

      input, select, textarea, button {
        font: inherit;
        border-radius: 10px;
        border: 1px solid var(--line);
        background: var(--surface-2);
        color: var(--text);
        padding: .6rem .7rem;
        width: 100%;
      }

      textarea { min-height: 5rem; resize: vertical; }

      button {
        cursor: pointer;
        border: none;
        background: var(--accent);
        color: #221d00;
        font-weight: 650;
        margin-top: .9rem;
      }
      button:disabled { opacity: .55; cursor: progress; }
      button.secondary { background: var(--surface-2); color: var(--text); border: 1px solid var(--line); }
      button.link {
        background: none; color: var(--accent); width: auto; padding: 0; margin: 0;
        font-weight: 500; text-decoration: underline;
      }

      .tabs { display: flex; gap: .4rem; margin-bottom: 1rem; flex-wrap: wrap; }
      .tabs button {
        width: auto; margin: 0; padding: .45rem .85rem; border-radius: 999px;
        background: var(--surface); border: 1px solid var(--line); color: var(--muted); font-weight: 550;
      }
      .tabs button[aria-selected="true"] { background: var(--accent); color: #221d00; border-color: var(--accent); }

      ul.list { list-style: none; margin: 0; padding: 0; }
      ul.list li {
        display: flex; align-items: center; justify-content: space-between; gap: .75rem;
        padding: .65rem 0; border-bottom: 1px solid var(--line);
      }
      ul.list li:last-child { border-bottom: none; }

      .group-item { width: 100%; text-align: left; background: var(--surface-2); border: 1px solid var(--line);
        color: var(--text); margin: 0 0 .6rem; padding: .8rem; border-radius: 12px; font-weight: 500; }

      /* Names and quotes are free text and may contain no spaces at all. Without
         this a single long run widens the page and every card collapses. */
      .group-item, blockquote, ul.list li, th, td, .pill, .notice { overflow-wrap: anywhere; }

      .pill { font-size: .72rem; padding: .18rem .55rem; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
      .pill.locked { color: var(--accent); border-color: var(--accent); }
      .pill.open { color: var(--ok); border-color: var(--ok); }

      .checks { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .3rem; }
      .checks label {
        margin: 0; display: inline-flex; align-items: center; gap: .35rem; color: var(--text);
        background: var(--surface-2); border: 1px solid var(--line); border-radius: 999px; padding: .3rem .7rem;
        font-size: .85rem; cursor: pointer;
      }
      .checks input { width: auto; }

      .notice { padding: .7rem .8rem; border-radius: 10px; margin-bottom: 1rem; font-size: .9rem; }
      .notice.error { background: rgba(255, 123, 123, .12); border: 1px solid var(--danger); color: var(--danger); }
      .notice.ok { background: rgba(123, 220, 181, .12); border: 1px solid var(--ok); color: var(--ok); }

      .locked-box { text-align: center; padding: 2rem 1rem; }
      .locked-box .count { font-size: 2.6rem; font-weight: 700; color: var(--accent); }

      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: .5rem .5rem .5rem 0; border-bottom: 1px solid var(--line); }
      th:last-child, td:last-child { padding-right: 0; }
      th { color: var(--muted); font-size: .8rem; font-weight: 550; }
      td.num, th.num { text-align: right; }

      blockquote {
        margin: 0 0 .9rem; padding: .8rem 1rem; background: var(--surface-2);
        border-left: 3px solid var(--accent); border-radius: 0 10px 10px 0;
      }
      blockquote footer { color: var(--muted); font-size: .85rem; margin-top: .4rem; }

      input[type="file"] { padding: .5rem; background: var(--surface-2); color: var(--muted); font-size: .85rem; }
      input[type="file"]::file-selector-button {
        font: inherit; font-weight: 600; margin-right: .6rem; padding: .35rem .7rem; cursor: pointer;
        border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--text);
      }

      .photo-preview { margin-top: .6rem; }
      .photo-preview img { max-height: 12rem; border-radius: 10px; border: 1px solid var(--line); display: block; }
      .photo-preview button { width: auto; margin: .5rem 0 0; padding: .35rem .8rem; font-size: .85rem; }

      /* Reserves nothing until the picture arrives, so a quote without one — or
         one whose picture fails to load — reads exactly as it did before. */
      .quote-photo img { max-width: 100%; border-radius: 10px; margin-top: .7rem; display: block; }

      /* Inline style attributes cannot be hashed or nonced, so every rule lives here. */
      .group-title { margin-top: .6rem; }
      .vault-note { margin-top: .7rem; }
    `;

const appScript = `
      (function () {
        'use strict';

        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.register('/sw.js').catch(function () {});
        }

        var TOKEN_KEY = 'quotes-journal.token';
        var INVITE_KEY = 'quotes-journal.pending-invite';
        var app = document.getElementById('app');

        var state = {
          token: localStorage.getItem(TOKEN_KEY),
          user: null,
          groups: [],
          /** Whether the group list on screen came from the server this session. */
          groupsLoaded: false,
          group: null,
          tab: 'collect',
          reveal: null,
          notice: null,
          pendingInvite: readInviteFromLocation(),
          /** The shrunk, re-encoded photo waiting to go up with the next quote. */
          pendingImage: null,
        };

        /**
         * Phone photos are several megabytes and the server refuses anything over
         * a megabyte, so a chosen picture is shrunk and re-encoded in the browser
         * before it is sent. Passing it through a canvas also drops the EXIF
         * block, which means the coordinates of where the photo was taken never
         * leave the device.
         */
        var MAX_IMAGE_EDGE = 1280;
        var MAX_IMAGE_BYTES = 1000000;

        function escapeHtml(value) {
          return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }

        function notify(message, kind) {
          state.notice = message ? { message: message, kind: kind || 'error' } : null;
        }

        function noticeHtml() {
          if (!state.notice) {
            return '';
          }
          return '<div class="notice ' + state.notice.kind + '">' + escapeHtml(state.notice.message) + '</div>';
        }

        async function api(path, options) {
          var settings = options || {};
          var headers = { 'content-type': 'application/json' };
          if (state.token) {
            headers.authorization = 'Bearer ' + state.token;
          }

          var response;
          try {
            response = await fetch(path, {
              method: settings.method || 'GET',
              headers: headers,
              body: settings.body ? JSON.stringify(settings.body) : undefined,
            });
          } catch (error) {
            // The service worker can open the app with no connection, but every
            // quote lives on the server. Saying so is more use than the
            // browser's own "Failed to fetch".
            throw new Error(
              navigator.onLine === false
                ? 'You are offline. Quotes are kept on the server, so this needs a connection.'
                : 'Could not reach the server. Check your connection and try again.',
            );
          }

          var payload = {};
          try {
            payload = await response.json();
          } catch (error) {
            payload = {};
          }

          if (response.status === 401 && state.token) {
            signOut('Your session expired. Please sign in again.');
            throw new Error('unauthenticated');
          }

          if (response.status === 429 && payload.retryAfterSeconds) {
            var wait = payload.retryAfterSeconds > 90
              ? Math.ceil(payload.retryAfterSeconds / 60) + ' minutes'
              : payload.retryAfterSeconds + ' seconds';
            var throttled = new Error((payload.error || 'Too many attempts') + '. Try again in about ' + wait + '.');
            throttled.status = 429;
            throw throttled;
          }

          if (!response.ok) {
            var failure = new Error(payload.error || 'Something went wrong');
            failure.payload = payload;
            failure.status = response.status;
            throw failure;
          }

          return settings.withStatus ? { status: response.status, body: payload } : payload;
        }

        function signOut(message) {
          state.token = null;
          state.user = null;
          state.groups = [];
          state.groupsLoaded = false;
          state.group = null;
          state.pendingImage = null;
          localStorage.removeItem(TOKEN_KEY);
          notify(message || null, 'error');
          render();
        }

        function daysUntil(iso) {
          var diff = new Date(iso).getTime() - Date.now();
          return Math.max(0, Math.ceil(diff / 86400000));
        }

        function memberName(memberId) {
          var members = (state.group && state.group.members) || [];
          for (var index = 0; index < members.length; index += 1) {
            if (members[index].id === memberId) {
              return members[index].name;
            }
          }
          return 'Unknown member';
        }

        /* ---------- views ---------- */

        function authView() {
          return (
            '<header class="bar"><div class="brand"><span class="mark">&#8220;&#8221;</span> Quotes Journal</div></header>' +
            noticeHtml() +
            (state.pendingInvite
              ? '<div class="notice ok">You have been invited to a group. Sign in or create an account to join it.</div>'
              : '') +
            '<div class="card">' +
            '<h1>Collect the year&#39;s best quotes</h1>' +
            '<p class="muted">Everything your group records stays sealed until January 1st. Then the quotes, the stats and the quiz open up at once.</p>' +
            '</div>' +
            '<div class="card">' +
            '<div class="tabs" role="tablist">' +
            '<button role="tab" data-auth-tab="login" aria-selected="' + (state.authTab !== 'register') + '">Sign in</button>' +
            '<button role="tab" data-auth-tab="register" aria-selected="' + (state.authTab === 'register') + '">Create account</button>' +
            '</div>' +
            (state.authTab === 'register' ? registerFormHtml() : loginFormHtml()) +
            '</div>'
          );
        }

        function loginFormHtml() {
          return (
            '<form id="login-form">' +
            '<label for="login-email">Email</label>' +
            '<input id="login-email" name="email" type="email" autocomplete="email" required />' +
            '<label for="login-password">Password</label>' +
            '<input id="login-password" name="password" type="password" autocomplete="current-password" required />' +
            '<button type="submit">Sign in</button>' +
            '</form>'
          );
        }

        function registerFormHtml() {
          return (
            '<form id="register-form">' +
            '<label for="register-name">Display name</label>' +
            '<input id="register-name" name="displayName" required />' +
            '<p class="small muted">This is the name your friends see next to quotes.</p>' +
            '<label for="register-email">Email</label>' +
            '<input id="register-email" name="email" type="email" autocomplete="email" required />' +
            '<label for="register-password">Password</label>' +
            '<input id="register-password" name="password" type="password" autocomplete="new-password" minlength="10" required />' +
            '<p class="small muted">At least 10 characters.</p>' +
            '<label for="register-confirm">Repeat password</label>' +
            '<input id="register-confirm" name="passwordConfirm" type="password" autocomplete="new-password" required />' +
            '<p class="small muted" id="confirm-hint">There is no password reset yet, so a typo here would lock you out of the account.</p>' +
            '<button type="submit">Create account</button>' +
            '</form>'
          );
        }

        function groupsView() {
          var items = state.groups
            .map(function (group) {
              var locked = new Date(new Date(Date.UTC(group.revealYear + 1, 0, 1)).getTime()) > new Date();
              return (
                '<button class="group-item" data-open-group="' + escapeHtml(group.groupId) + '">' +
                escapeHtml(group.name) +
                '<div class="small muted">' +
                escapeHtml(group.revealYear) +
                ' &middot; ' +
                (locked ? 'unlocks 1 Jan ' + (group.revealYear + 1) : 'open') +
                ' &middot; ' +
                escapeHtml(group.role) +
                '</div></button>'
              );
            })
            .join('');

          return (
            headerHtml() +
            noticeHtml() +
            '<div class="card">' +
            '<h2>Your groups</h2>' +
            (items ||
              (state.groupsLoaded
                ? '<p class="muted">No groups yet. Create one below, or paste an invite link from a friend.</p>'
                : // Not the same thing as having none, and saying so would be a
                  // lie to anyone who opened the installed app on a train.
                  '<p class="muted">Your groups could not be loaded. They are on the server and need a connection.</p>')) +
            '</div>' +
            '<div class="card">' +
            '<h2>Start a group</h2>' +
            '<form id="create-group-form">' +
            '<label for="group-name">Group name</label>' +
            '<input id="group-name" name="name" required placeholder="Sunday football crew" />' +
            '<label for="group-year">Collect quotes for</label>' +
            '<input id="group-year" name="revealYear" type="number" required value="' + new Date().getUTCFullYear() + '" />' +
            '<p class="small muted">Everything unlocks on 1 January of the following year.</p>' +
            '<button type="submit">Create group</button>' +
            '</form>' +
            '</div>' +
            '<div class="card">' +
            '<h2>Join with an invite</h2>' +
            '<form id="join-form">' +
            '<label for="invite-code">Invite link or code</label>' +
            '<input id="invite-code" name="inviteCode" required value="' + escapeHtml(state.pendingInvite || '') + '" />' +
            '<button type="submit">Join group</button>' +
            '</form>' +
            '</div>'
          );
        }

        function headerHtml() {
          return (
            '<header class="bar">' +
            '<div class="brand"><span class="mark">&#8220;&#8221;</span> Quotes Journal</div>' +
            '<div class="small muted">' +
            escapeHtml(state.user ? state.user.displayName : '') +
            ' &middot; <button class="link" id="sign-out">Sign out</button></div>' +
            '</header>'
          );
        }

        function groupView() {
          var group = state.group;
          // Once the reveal has passed the server refuses new quotes, so
          // offering the form would be a promise the app cannot keep.
          var tabs = group.locked ? ['collect', 'members'] : ['members'];
          if (!group.locked) {
            tabs.unshift('reveal');
          }

          // A tab from a URL or an earlier group may not exist here — a revealed
          // group has no collect tab — so settle on a real one before rendering.
          if (tabs.indexOf(state.tab) === -1) {
            state.tab = tabs[0];
          }

          var tabsHtml = tabs
            .map(function (tab) {
              var labels = { collect: 'Add a quote', members: 'Members', reveal: 'The reveal' };
              return (
                '<button role="tab" data-tab="' + tab + '" aria-selected="' + (state.tab === tab) + '">' +
                labels[tab] +
                '</button>'
              );
            })
            .join('');

          var body;
          if (state.tab === 'members') {
            body = membersTab();
          } else if (state.tab === 'reveal') {
            body = revealTab();
          } else {
            body = collectTab();
          }

          return (
            headerHtml() +
            '<button class="link" id="back-to-groups">&larr; All groups</button>' +
            '<h1 class="group-title">' + escapeHtml(group.name) + '</h1>' +
            '<p class="muted small">' +
            (group.locked
              ? 'Sealed until 1 January ' + (group.revealYear + 1) + ' &middot; ' + daysUntil(group.revealAt) + ' days to go'
              : 'Open since 1 January ' + (group.revealYear + 1)) +
            '</p>' +
            noticeHtml() +
            '<div class="tabs" role="tablist">' + tabsHtml + '</div>' +
            body
          );
        }

        function collectTab() {
          var group = state.group;
          var others = group.members.filter(function (member) {
            return !member.isYou;
          });

          var options = group.members
            .map(function (member) {
              return '<option value="' + escapeHtml(member.id) + '">' + escapeHtml(member.name) + (member.isYou ? ' (you)' : '') + '</option>';
            })
            .join('');

          var involved = others
            .map(function (member) {
              return (
                '<label><input type="checkbox" name="involved" value="' + escapeHtml(member.id) + '" /> ' +
                escapeHtml(member.name) +
                '</label>'
              );
            })
            .join('');

          return (
            '<div class="card">' +
            '<form id="quote-form">' +
            '<label for="quote-text">What was said?</label>' +
            '<textarea id="quote-text" name="text" required placeholder="&#8220;I am not lost, the map is wrong.&#8221;"></textarea>' +
            '<p class="small muted" id="quote-count">0 / 500</p>' +
            '<label for="quote-said-by">Who said it?</label>' +
            '<select id="quote-said-by" name="saidByMemberId" required>' + options + '</select>' +
            (involved ? '<label>Who else was there?</label><div class="checks">' + involved + '</div>' : '') +
            '<label for="quote-photo">Add a picture (optional)</label>' +
            '<input id="quote-photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp" />' +
            '<p class="small muted" id="photo-status">For the context a quote alone does not carry. Shrunk on this device before it is sent.</p>' +
            '<div class="photo-preview" id="photo-preview"></div>' +
            '<button type="submit">Save quote</button>' +
            '<p class="small muted vault-note">Saved quotes disappear straight into the vault &mdash; nobody, including you, can read them back before the reveal.</p>' +
            '</form>' +
            '</div>' +
            '<div class="card locked-box">' +
            '<div class="count">' + escapeHtml(group.progress.totalQuotes) + '</div>' +
            '<p class="muted">quotes collected so far &middot; ' + escapeHtml(group.progress.recordedByYou) + ' by you</p>' +
            '</div>'
          );
        }

        function membersTab() {
          var group = state.group;
          var items = group.members
            .map(function (member) {
              return (
                '<li><span>' + escapeHtml(member.name) + (member.isYou ? ' <span class="pill">you</span>' : '') + '</span>' +
                '<span class="pill">' + (member.isGuest ? 'not signed up' : member.role) + '</span></li>'
              );
            })
            .join('');

          return (
            '<div class="card">' +
            '<h2>Members</h2>' +
            '<ul class="list">' + items + '</ul>' +
            '</div>' +
            '<div class="card">' +
            '<h2>Invite a friend</h2>' +
            '<p class="small muted">Anyone with this link can join the group.</p>' +
            '<div id="invite-box"><button class="secondary" id="show-invite">Show invite link</button></div>' +
            (group.you.role === 'owner'
              ? '<button class="secondary" id="rotate-invite">Rotate link</button>' +
                '<p class="small muted">Rotating makes every previously shared link stop working.</p>'
              : '') +
            '</div>' +
            '<div class="card">' +
            '<h2>Add someone without an account</h2>' +
            '<p class="small muted">Use this for friends who should be quotable but are not using the app.</p>' +
            '<form id="member-form">' +
            '<label for="member-name">Name</label>' +
            '<input id="member-name" name="name" required />' +
            '<button type="submit">Add member</button>' +
            '</form>' +
            '</div>'
          );
        }

        function revealTab() {
          if (!state.reveal) {
            return '<div class="card"><p class="muted">Opening the vault&hellip;</p></div>';
          }

          var quotes = state.reveal.quotes
            .map(function (quote) {
              var involved = (quote.involvedMemberIds || [])
                .filter(function (id) { return id !== quote.saidByMemberId; })
                .map(memberName);

              return (
                '<blockquote>' +
                escapeHtml(quote.text) +
                (quote.image ? '<div class="quote-photo" data-photo="' + escapeHtml(quote.id) + '"></div>' : '') +
                '<footer>&mdash; ' + escapeHtml(memberName(quote.saidByMemberId)) +
                ', recorded by ' + escapeHtml(memberName(quote.recordedByMemberId)) +
                (involved.length ? ' &middot; with ' + escapeHtml(involved.join(', ')) : '') +
                '</footer></blockquote>'
              );
            })
            .join('');

          var rows = state.reveal.stats.leaderboard
            .map(function (entry) {
              return (
                '<tr><td>' + escapeHtml(entry.name) + '</td>' +
                '<td class="num">' + escapeHtml(entry.said) + '</td>' +
                '<td class="num">' + escapeHtml(entry.persisted) + '</td></tr>'
              );
            })
            .join('');

          return (
            '<div class="card">' +
            '<h2>Statistics</h2>' +
            '<table><thead><tr><th>Member</th><th class="num">Quoted</th><th class="num">Collected</th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table>' +
            '</div>' +
            '<div class="card">' +
            '<h2>' + escapeHtml(state.reveal.quotes.length) + (state.reveal.quotes.length === 1 ? ' quote' : ' quotes') + '</h2>' +
            (quotes || '<p class="muted">This group never recorded a quote.</p>') +
            '</div>'
          );
        }

        /* ---------- actions ---------- */

        /**
         * Re-rendering replaces the whole document, which throws away whatever
         * the user had typed. That is right after a successful save — the form
         * should come back empty — but wrong after a validation error, where
         * losing a half-written quote is the worst thing the app can do. So the
         * failure paths ask for the input back.
         */
        function readForms() {
          var snapshot = {};
          var fields = app.querySelectorAll('input, textarea, select');

          for (var index = 0; index < fields.length; index += 1) {
            var field = fields[index];
            var key = field.id || field.name;
            // A file input's value is read-only for security reasons: it cannot
            // be snapshotted and writing it back would throw. The chosen picture
            // is held in state.pendingImage across re-renders instead.
            if (!key || field.type === 'file') {
              continue;
            }
            if (field.type === 'checkbox' || field.type === 'radio') {
              snapshot['@' + key + '=' + field.value] = field.checked;
            } else {
              snapshot[key] = field.value;
            }
          }

          return snapshot;
        }

        function writeForms(snapshot) {
          var fields = app.querySelectorAll('input, textarea, select');

          for (var index = 0; index < fields.length; index += 1) {
            var field = fields[index];
            var key = field.id || field.name;
            if (!key || field.type === 'file') {
              continue;
            }
            if (field.type === 'checkbox' || field.type === 'radio') {
              var checked = snapshot['@' + key + '=' + field.value];
              if (checked !== undefined) {
                field.checked = checked;
              }
            } else if (snapshot[key] !== undefined) {
              field.value = snapshot[key];
            }
          }
        }

        function render(options) {
          var keepInput = options && options.keepInput;
          var snapshot = keepInput ? readForms() : null;

          if (!state.token) {
            app.innerHTML = authView();
          } else if (state.group) {
            app.innerHTML = groupView();
          } else {
            app.innerHTML = groupsView();
          }

          if (snapshot) {
            writeForms(snapshot);
          }

          state.notice = null;
          bind();
        }

        function onSubmit(id, handler) {
          var form = document.getElementById(id);
          if (!form) {
            return;
          }

          form.addEventListener('submit', async function (event) {
            event.preventDefault();
            var button = form.querySelector('button[type="submit"]');
            if (button) {
              button.disabled = true;
            }

            try {
              await handler(form);
            } catch (error) {
              if (error && error.message !== 'unauthenticated') {
                notify(error.message, 'error');
                render({ keepInput: true });
              }
            } finally {
              if (button) {
                button.disabled = false;
              }
            }
          });
        }

        function onClick(id, handler) {
          var element = document.getElementById(id);
          if (element) {
            element.addEventListener('click', handler);
          }
        }

        function bind() {
          document.querySelectorAll('[data-auth-tab]').forEach(function (button) {
            button.addEventListener('click', function () {
              state.authTab = button.getAttribute('data-auth-tab');
              render();
            });
          });

          document.querySelectorAll('[data-tab]').forEach(function (button) {
            button.addEventListener('click', function () {
              state.tab = button.getAttribute('data-tab');
              history.replaceState({}, '', pathFor(state.group.id, state.tab));
              render();
              if (state.tab === 'reveal' && !state.reveal) {
                loadReveal();
              }
            });
          });

          document.querySelectorAll('[data-open-group]').forEach(function (button) {
            button.addEventListener('click', function () {
              openGroup(button.getAttribute('data-open-group'));
            });
          });

          onClick('sign-out', function () { signOut(); });
          onClick('back-to-groups', function () {
            state.group = null;
            state.reveal = null;
            state.pendingImage = null;
            state.tab = 'collect';
            history.pushState({}, '', '/app');
            render();
          });

          onClick('show-invite', async function () {
            try {
              var invite = await api('/api/groups/' + encodeURIComponent(state.group.id) + '/invite');
              showInvite(invite.inviteCode);
            } catch (error) {
              notify(error.message, 'error');
              render();
            }
          });

          onClick('rotate-invite', async function () {
            try {
              var invite = await api('/api/groups/' + encodeURIComponent(state.group.id) + '/invite/rotate', {
                method: 'POST',
                body: {},
              });
              showInvite(invite.inviteCode);
            } catch (error) {
              notify(error.message, 'error');
              render();
            }
          });

          onSubmit('login-form', async function (form) {
            var result = await api('/api/auth/login', {
              method: 'POST',
              body: { email: form.email.value, password: form.password.value },
            });
            await startSession(result, true);
          });

          var confirmField = document.getElementById('register-confirm');
          var confirmHint = document.getElementById('confirm-hint');
          if (confirmField && confirmHint) {
            // Live, so the mismatch is caught while the second field is still in
            // focus rather than after the form has been thrown back.
            confirmField.addEventListener('input', function () {
              var password = document.getElementById('register-password');
              var typed = confirmField.value.length > 0;
              var matches = !password || confirmField.value === password.value;
              confirmHint.textContent = !typed
                ? 'There is no password reset yet, so a typo here would lock you out of the account.'
                : matches
                  ? 'The passwords match.'
                  : 'The passwords do not match yet.';
              confirmHint.className = typed && !matches ? 'small' : 'small muted';
            });
          }

          onSubmit('register-form', async function (form) {
            // Checked here and never sent: the confirmation exists to catch a
            // typo in the browser, and the server has no use for a second copy
            // of the password.
            if (form.password.value !== form.passwordConfirm.value) {
              throw new Error('Those two passwords do not match');
            }

            var result = await api('/api/auth/register', {
              method: 'POST',
              body: {
                displayName: form.displayName.value,
                email: form.email.value,
                password: form.password.value,
              },
            });
            await startSession(result, true);
          });

          onSubmit('create-group-form', async function (form) {
            var created = await api('/api/groups', {
              method: 'POST',
              body: { name: form.name.value, revealYear: Number(form.revealYear.value) },
            });
            await loadGroups();
            state.group = created.group;
            state.tab = defaultTab(created.group);
            history.pushState({}, '', pathFor(created.group.id, state.tab));
            notify('Group created. Share the invite link from the members tab.', 'ok');
            render();
            if (state.tab === 'reveal') {
              loadReveal();
            }
          });

          onSubmit('join-form', async function (form) {
            var joined = await acceptInvite(readInvite(form.inviteCode.value));
            forgetPendingInvite();
            await loadGroups();
            state.group = joined.body.group;
            state.tab = defaultTab(joined.body.group);
            history.pushState({}, '', pathFor(joined.body.group.id, state.tab));
            // 201 means the join happened; 200 means you were already in.
            notify(
              joined.status === 201
                ? 'You joined ' + joined.body.group.name + '.'
                : 'You are already a member of ' + joined.body.group.name + '.',
              'ok',
            );
            render();
          });

          onSubmit('member-form', async function (form) {
            await api('/api/groups/' + encodeURIComponent(state.group.id) + '/members', {
              method: 'POST',
              body: { name: form.name.value },
            });
            await openGroup(state.group.id, 'members');
            notify('Member added.', 'ok');
            render();
          });

          var quoteText = document.getElementById('quote-text');
          var quoteCount = document.getElementById('quote-count');
          if (quoteText && quoteCount) {
            var showCount = function () {
              quoteCount.textContent = quoteText.value.length + ' / 500';
              quoteCount.className = quoteText.value.length > 500 ? 'small' : 'small muted';
            };
            quoteText.addEventListener('input', showCount);
            showCount();
          }

          var photoField = document.getElementById('quote-photo');
          if (photoField) {
            renderPendingImage();
            photoField.addEventListener('change', async function () {
              var file = photoField.files && photoField.files[0];
              if (!file) {
                state.pendingImage = null;
                renderPendingImage();
                return;
              }

              setPhotoStatus('Preparing the picture\u2026', false);
              try {
                state.pendingImage = await prepareImage(file);
                setPhotoStatus('Ready. It is sealed with the quote until the reveal.', false);
              } catch (error) {
                state.pendingImage = null;
                photoField.value = '';
                setPhotoStatus(error.message || 'That picture could not be read', true);
              }
              renderPendingImage();
            });
          }

          if (state.tab === 'reveal' && state.reveal) {
            loadQuotePhotos();
          }

          onSubmit('quote-form', async function (form) {
            var involved = Array.prototype.slice
              .call(form.querySelectorAll('input[name="involved"]:checked'))
              .map(function (input) { return input.value; });

            var saved = await api('/api/groups/' + encodeURIComponent(state.group.id) + '/quotes', {
              method: 'POST',
              body: {
                text: form.text.value,
                saidByMemberId: form.saidByMemberId.value,
                involvedMemberIds: involved,
              },
            });

            // The picture goes up second, against the quote that now exists. If
            // it fails the quote still stands — losing the words because a photo
            // would not upload would be much worse than saying so and moving on.
            var pending = state.pendingImage;
            var imageError = null;
            if (pending) {
              try {
                await uploadImage(state.group.id, saved.quote.id, pending);
              } catch (error) {
                imageError = error.message;
              }
              state.pendingImage = null;
            }

            await openGroup(state.group.id, 'collect');
            notify(
              imageError
                ? 'Quote saved, but the picture could not be attached: ' + imageError
                : 'Saved. It is sealed until the reveal.',
              imageError ? 'error' : 'ok',
            );
            render();
          });
        }

        function blobFromCanvas(canvas, quality) {
          return new Promise(function (resolve) {
            canvas.toBlob(function (blob) { resolve(blob); }, 'image/jpeg', quality);
          });
        }

        /**
         * Shrinks a chosen photo to something the server will accept, dropping
         * the quality a step at a time until it fits rather than refusing a
         * picture that is merely detailed.
         */
        async function prepareImage(file) {
          var bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
          var longestEdge = Math.max(bitmap.width, bitmap.height);
          var scale = Math.min(1, MAX_IMAGE_EDGE / longestEdge);
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(bitmap.width * scale));
          canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          bitmap.close();

          var quality = 0.82;
          var blob = await blobFromCanvas(canvas, quality);
          while (blob && blob.size > MAX_IMAGE_BYTES && quality > 0.4) {
            quality -= 0.15;
            blob = await blobFromCanvas(canvas, quality);
          }

          if (!blob || blob.size > MAX_IMAGE_BYTES) {
            throw new Error('That picture is too large, even after shrinking it');
          }

          return blob;
        }

        /** Draws whatever picture is queued for the next quote, or nothing. */
        function renderPendingImage() {
          var holder = document.getElementById('photo-preview');
          if (!holder) {
            return;
          }

          holder.textContent = '';
          if (!state.pendingImage) {
            return;
          }

          var image = document.createElement('img');
          var url = URL.createObjectURL(state.pendingImage);
          image.src = url;
          image.alt = 'The picture you chose for this quote';
          image.addEventListener('load', function () { URL.revokeObjectURL(url); });

          var remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'secondary';
          remove.textContent = 'Remove picture';
          remove.addEventListener('click', function () {
            state.pendingImage = null;
            var field = document.getElementById('quote-photo');
            if (field) {
              field.value = '';
            }
            setPhotoStatus('For the context a quote alone does not carry. Shrunk on this device before it is sent.', false);
            renderPendingImage();
          });

          holder.appendChild(image);
          holder.appendChild(remove);
        }

        function setPhotoStatus(message, isError) {
          var status = document.getElementById('photo-status');
          if (status) {
            status.textContent = message;
            status.className = isError ? 'small' : 'small muted';
          }
        }

        /**
         * Sends the picture as raw bytes rather than through api(): base64 inside
         * a JSON envelope would be a third larger and would not fit the body cap
         * every other route relies on.
         */
        async function uploadImage(groupId, quoteId, blob) {
          var response = await fetch(
            '/api/groups/' + encodeURIComponent(groupId) + '/quotes/' + encodeURIComponent(quoteId) + '/image',
            {
              method: 'POST',
              headers: { authorization: 'Bearer ' + state.token, 'content-type': blob.type || 'image/jpeg' },
              body: blob,
            },
          );

          if (!response.ok) {
            var payload = {};
            try {
              payload = await response.json();
            } catch (error) {
              payload = {};
            }
            throw new Error(payload.error || 'The picture could not be saved');
          }
        }

        /**
         * Pictures are fetched with the bearer token and rendered as object URLs.
         * An <img src> cannot carry an Authorization header, and the alternative
         * — a signed URL — would put a credential somewhere history, referrers
         * and shared screenshots can reach it.
         */
        function loadQuotePhotos() {
          document.querySelectorAll('[data-photo]').forEach(function (holder) {
            var quoteId = holder.getAttribute('data-photo');
            var path =
              '/api/groups/' + encodeURIComponent(state.group.id) + '/quotes/' + encodeURIComponent(quoteId) + '/image';

            fetch(path, { headers: { authorization: 'Bearer ' + state.token } })
              .then(function (response) { return response.ok ? response.blob() : null; })
              .then(function (blob) {
                if (!blob) {
                  return;
                }
                var image = document.createElement('img');
                var url = URL.createObjectURL(blob);
                image.src = url;
                image.alt = 'Picture attached to this quote';
                image.addEventListener('load', function () { URL.revokeObjectURL(url); });
                holder.appendChild(image);
              })
              // The quote itself reads perfectly well without its picture, so a
              // failure here stays quiet rather than throwing a banner over the
              // whole reveal.
              .catch(function () {});
          });
        }

        function showInvite(code) {
          var box = document.getElementById('invite-box');
          if (box) {
            box.innerHTML = '<p class="mono small">' + escapeHtml(inviteUrl(code)) + '</p>';
          }
        }

        /** Pulls the code out of a '?invite=' or '#invite=' string, if there is one. */
        function inviteFromText(value) {
          var trimmed = (value || '').trim();
          var marker = trimmed.indexOf('invite=');
          return marker === -1 ? '' : decodeURIComponent(trimmed.slice(marker + 'invite='.length));
        }

        /** Accepts either a raw code or a full invite URL pasted from a message. */
        function readInvite(value) {
          var trimmed = (value || '').trim();
          return inviteFromText(trimmed) || trimmed;
        }

        /**
         * Invite codes travel in the fragment, which browsers never send to the
         * server, so they stay out of access logs, referrers and proxies. Links
         * shared before that used '?invite=', so those are still read.
         */
        function readInviteFromLocation() {
          var code = inviteFromText(location.hash) || inviteFromText(location.search);
          if (code) {
            // Stashed before the URL is cleaned, so reloading the landing page
            // — or coming back to a tab the phone restored — does not silently
            // drop the invite and leave the user in a group-less account.
            try {
              sessionStorage.setItem(INVITE_KEY, code);
            } catch (error) {
              /* private mode: fall back to the in-memory copy */
            }
            history.replaceState({}, '', location.pathname);
            return code;
          }

          try {
            return sessionStorage.getItem(INVITE_KEY);
          } catch (error) {
            return null;
          }
        }

        function forgetPendingInvite() {
          state.pendingInvite = null;
          try {
            sessionStorage.removeItem(INVITE_KEY);
          } catch (error) {
            /* nothing to clean up */
          }
        }

        /** Built from this origin: the server never composes a link from a header. */
        function inviteUrl(code) {
          return location.origin + '/join#invite=' + encodeURIComponent(code);
        }

        async function startSession(result, justSignedIn) {
          state.token = result.token;
          state.user = result.user;
          localStorage.setItem(TOKEN_KEY, result.token);

          if (state.pendingInvite) {
            try {
              var joined = await acceptInvite(state.pendingInvite);
              notify(
                joined.status === 201
                  ? 'You joined ' + joined.body.group.name + '.'
                  : 'You are already a member of ' + joined.body.group.name + '.',
                'ok',
              );
            } catch (error) {
              notify(
                (justSignedIn ? 'Signed in, but that invite link could not be used: ' : 'That invite link could not be used: ') +
                  error.message,
                'error',
              );
            }
            forgetPendingInvite();
            history.replaceState({}, '', '/app');
          }

          await loadGroups();
          render();
        }

        async function loadGroups() {
          var account = await api('/api/auth/me');
          state.user = account.user;
          state.groups = account.groups;
          state.groupsLoaded = true;
        }

        /**
         * Accepts an invite, and if the group already has someone by this name,
         * asks for another rather than dead-ending: the display name is global
         * but a member name is per-group.
         */
        async function acceptInvite(code) {
          try {
            return await api('/api/invites/accept', { method: 'POST', body: { inviteCode: code }, withStatus: true });
          } catch (error) {
            if (!error.payload || !error.payload.nameTaken) {
              throw error;
            }

            var alternative = prompt(
              'Someone in that group already goes by your name. What should they call you there?',
              state.user ? state.user.displayName : '',
            );

            if (!alternative) {
              throw error;
            }

            return api('/api/invites/accept', {
              method: 'POST',
              body: { inviteCode: code, memberName: alternative },
              withStatus: true,
            });
          }
        }

        /**
         * The app had no history entries at all: Back left the page entirely,
         * which on a phone is the natural "up" gesture, and a reload dropped
         * you to the group list. Each group and tab now has a real URL. The
         * Worker serves the shell for any non-API path, so these survive a
         * refresh.
         */
        function pathFor(groupId, tab) {
          return groupId ? '/groups/' + encodeURIComponent(groupId) + '/' + (tab || 'collect') : '/app';
        }

        // Split rather than matched: this file is a template literal, so a
        // backslash in a regex here is eaten before the browser ever sees it.
        function locationTarget() {
          var parts = location.pathname.split('/').filter(Boolean);
          if (parts[0] !== 'groups' || !parts[1]) {
            return null;
          }
          return { groupId: decodeURIComponent(parts[1]), tab: parts[2] || null };
        }

        /** Collecting is the point during the year; the reveal is the point after. */
        function defaultTab(group) {
          return group.locked ? 'collect' : 'reveal';
        }

        async function openGroup(groupId, tab, options) {
          // Re-reading the group the user is already looking at — after saving a
          // quote, say — is a refresh, not a navigation. Pushing for those would
          // stack duplicate entries and Back would appear to do nothing.
          var reopening = state.group && state.group.id === groupId;

          try {
            var result = await api('/api/groups/' + encodeURIComponent(groupId));
            if (!reopening) {
              // A picture chosen for one group's form has no meaning in another.
              state.pendingImage = null;
            }
            state.group = result.group;
            state.tab = tab || defaultTab(result.group);
            state.reveal = null;

            if (!(options && options.fromHistory)) {
              var path = pathFor(groupId, state.tab);
              if (reopening) {
                history.replaceState({}, '', path);
              } else {
                history.pushState({}, '', path);
              }
            }

            render();
            if (state.tab === 'reveal') {
              loadReveal();
            }
          } catch (error) {
            if (error.message !== 'unauthenticated') {
              notify(error.message, 'error');
              render();
            }
          }
        }

        async function loadReveal() {
          try {
            var quotes = await api('/api/groups/' + encodeURIComponent(state.group.id) + '/quotes');
            var stats = await api('/api/groups/' + encodeURIComponent(state.group.id) + '/stats');
            state.reveal = { quotes: quotes.quotes, stats: stats };
            render();
          } catch (error) {
            if (error.message !== 'unauthenticated') {
              notify(error.message, 'error');
              render();
            }
          }
        }

        window.addEventListener('popstate', function () {
          var target = locationTarget();
          if (!state.token) {
            render();
            return;
          }

          if (target) {
            openGroup(target.groupId, target.tab, { fromHistory: true });
            return;
          }

          state.group = null;
          state.reveal = null;
          render();
        });

        async function boot() {
          if (!state.token) {
            render();
            return;
          }

          try {
            await loadGroups();
            if (state.pendingInvite) {
              await startSession({ token: state.token, user: state.user }, false);
              return;
            }
          } catch (error) {
            if (error.message === 'unauthenticated') {
              return;
            }
            notify(error.message, 'error');
          }

          var target = locationTarget();
          if (target) {
            await openGroup(target.groupId, target.tab, { fromHistory: true });
            return;
          }

          render();
        }

        boot();
      })();
    `;

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#0f1020" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/icon.svg" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <title>Quotes Journal</title>
    <style>${appStyles}</style>
  </head>
  <body>
    <main id="app" aria-live="polite"></main>
    <script>${appScript}</script>
  </body>
</html>`;

/** The one document the app is served as, identical on every response. */
export const renderAppHtml = (): string => html;

/** What the policy has to name for the app shell to run at all. */
export const appInline = { styles: appStyles, script: appScript };

/**
 * The privacy policy, served at /privacy. Both app stores require a reachable
 * policy URL in the listing, and the store data-safety declarations have to
 * match what this says — so it describes exactly what the code does and nothing
 * aspirational.
 *
 * Kept in the same file and under the same kind of policy as the app: one
 * inline style, named by its hash, and no scripts at all.
 */
const privacyStyles = `
      :root { --bg:#0f1020; --surface:#191a30; --line:#32345a; --text:#f2f2f7; --muted:#a2a4c4; --accent:#f8c630; color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin:0; background:var(--bg); color:var(--text);
        font:16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      main { max-width:680px; margin:0 auto; padding:2rem 1rem 4rem; }
      h1 { font-size:1.6rem; margin:0 0 .25rem; }
      h2 { font-size:1.1rem; margin:2rem 0 .5rem; }
      p, li { margin:0 0 .75rem; }
      ul { padding-left:1.2rem; }
      a { color:var(--accent); }
      .muted { color:var(--muted); }
      .card { background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:1rem 1.25rem; margin-top:1.5rem; }
      /* A hash names an inline style block; a style attribute cannot be named at all. */
      .flush { margin-top:0; }
    `;

const privacyHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#0f1020" />
    <title>Privacy — Quotes Journal</title>
    <style>${privacyStyles}</style>
  </head>
  <body>
    <main>
      <h1>Privacy</h1>
      <p class="muted">Quotes Journal &middot; last updated 8 September 2026</p>

      <p>Quotes Journal is a small app for recording things your friends said and
      reading them back at the end of the year. This page describes every piece of
      data it holds and what happens to it.</p>

      <h2>What is collected</h2>
      <ul>
        <li><strong>Your email address</strong>, so you can sign in and so an
        account can be recognised as yours.</li>
        <li><strong>A display name</strong> you choose, shown to the other members
        of your groups.</li>
        <li><strong>Your password</strong>, stored only as a PBKDF2-HMAC-SHA256
        hash with a random salt. The password itself is never written down.</li>
        <li><strong>The groups you belong to</strong>, the names of members in
        them, and the quotes recorded in them.</li>
        <li><strong>Pictures you choose to attach to a quote</strong>, which are
        optional. A picture is re-encoded in your browser before it is uploaded,
        which removes the EXIF metadata a camera writes into a photo file &mdash;
        including the GPS coordinates of where it was taken. Only the resized
        image reaches the server.</li>
      </ul>

      <h2>What is not collected</h2>
      <ul>
        <li>No analytics, tracking or advertising, of any kind.</li>
        <li>No contacts, location, microphone or camera access. Attaching a
        picture to a quote uses your device's own file picker, one photo at a
        time, on your explicit choice &mdash; the app never reads your library.</li>
        <li>No third-party services. Nothing is shared with anyone.</li>
        <li>Nothing is sold, ever.</li>
      </ul>

      <h2>Who can see your quotes</h2>
      <p>Quotes and their pictures are visible only to members of the group they were recorded in,
      and only after that group's reveal date. Before then the app shows a count
      and nothing else &mdash; not even to the person who wrote the quote down.
      Someone who is not a member of a group cannot see that the group exists.</p>

      <h2>Where it is stored</h2>
      <p>On Cloudflare Workers infrastructure, reachable only through
      <a href="https://quotes.huelin.dev">quotes.huelin.dev</a> over HTTPS. The
      app is run by an individual, not a company.</p>

      <h2>Deleting your data</h2>
      <p>There is no self-service delete yet. Email the address below and your
      account and its data will be removed. This is a known gap and is tracked
      publicly in the project's issue tracker.</p>

      <h2>Children</h2>
      <p>The app is not directed at children and collects nothing beyond what is
      listed above from anyone.</p>

      <h2>Changes</h2>
      <p>If this policy changes, the date at the top of this page changes with it.
      The app is open source, so every revision is visible in its history.</p>

      <div class="card">
        <h2 class="flush">Contact</h2>
        <p class="muted">For privacy questions or a deletion request, contact the
        maintainer through the
        <a href="https://github.com/dhuelin/quotes-journal">project repository</a>.</p>
      </div>
    </main>
  </body>
</html>`;


export const renderPrivacyHtml = (): string => privacyHtml;

export const privacyInline = { styles: privacyStyles };
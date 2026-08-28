/**
 * The whole client is one document: small enough to inline, which keeps the
 * Worker a single deployable unit with no build step or asset bucket.
 */
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
    <style>
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
      th, td { text-align: left; padding: .5rem 0; border-bottom: 1px solid var(--line); }
      th { color: var(--muted); font-size: .8rem; font-weight: 550; }
      td.num, th.num { text-align: right; }

      blockquote {
        margin: 0 0 .9rem; padding: .8rem 1rem; background: var(--surface-2);
        border-left: 3px solid var(--accent); border-radius: 0 10px 10px 0;
      }
      blockquote footer { color: var(--muted); font-size: .85rem; margin-top: .4rem; }
    </style>
  </head>
  <body>
    <main id="app" aria-live="polite"></main>
    <script>
      (function () {
        'use strict';

        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.register('/sw.js').catch(function () {});
        }

        var TOKEN_KEY = 'quotes-journal.token';
        var app = document.getElementById('app');

        var state = {
          token: localStorage.getItem(TOKEN_KEY),
          user: null,
          groups: [],
          group: null,
          tab: 'collect',
          reveal: null,
          notice: null,
          pendingInvite: new URL(location.href).searchParams.get('invite'),
        };

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

          var response = await fetch(path, {
            method: settings.method || 'GET',
            headers: headers,
            body: settings.body ? JSON.stringify(settings.body) : undefined,
          });

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

          if (!response.ok) {
            var failure = new Error(payload.error || 'Something went wrong');
            failure.payload = payload;
            failure.status = response.status;
            throw failure;
          }

          return payload;
        }

        function signOut(message) {
          state.token = null;
          state.user = null;
          state.groups = [];
          state.group = null;
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
            '<input id="register-name" name="displayName" required maxlength="60" />' +
            '<p class="small muted">This is the name your friends see next to quotes.</p>' +
            '<label for="register-email">Email</label>' +
            '<input id="register-email" name="email" type="email" autocomplete="email" required />' +
            '<label for="register-password">Password</label>' +
            '<input id="register-password" name="password" type="password" autocomplete="new-password" minlength="10" required />' +
            '<p class="small muted">At least 10 characters.</p>' +
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
            (items || '<p class="muted">No groups yet. Create one below, or paste an invite link from a friend.</p>') +
            '</div>' +
            '<div class="card">' +
            '<h2>Start a group</h2>' +
            '<form id="create-group-form">' +
            '<label for="group-name">Group name</label>' +
            '<input id="group-name" name="name" required maxlength="80" placeholder="Sunday football crew" />' +
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
          var tabs = ['collect', 'members'];
          if (!group.locked) {
            tabs.push('reveal');
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
          } else if (state.tab === 'reveal' && !group.locked) {
            body = revealTab();
          } else {
            body = collectTab();
          }

          return (
            headerHtml() +
            '<button class="link" id="back-to-groups">&larr; All groups</button>' +
            '<h1 style="margin-top:.6rem">' + escapeHtml(group.name) + '</h1>' +
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
            '<textarea id="quote-text" name="text" required maxlength="500" placeholder="&#8220;I am not lost, the map is wrong.&#8221;"></textarea>' +
            '<label for="quote-said-by">Who said it?</label>' +
            '<select id="quote-said-by" name="saidByMemberId" required>' + options + '</select>' +
            (involved ? '<label>Who else was there?</label><div class="checks">' + involved + '</div>' : '') +
            '<button type="submit">Save quote</button>' +
            '<p class="small muted" style="margin-top:.7rem">Saved quotes disappear straight into the vault &mdash; nobody, including you, can read them back before the reveal.</p>' +
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
            '<input id="member-name" name="name" required maxlength="60" />' +
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
            '<h2>' + escapeHtml(state.reveal.quotes.length) + ' quotes</h2>' +
            (quotes || '<p class="muted">This group never recorded a quote.</p>') +
            '</div>'
          );
        }

        /* ---------- actions ---------- */

        function render() {
          if (!state.token) {
            app.innerHTML = authView();
          } else if (state.group) {
            app.innerHTML = groupView();
          } else {
            app.innerHTML = groupsView();
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
                render();
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
            state.tab = 'collect';
            render();
          });

          onClick('show-invite', async function () {
            try {
              var invite = await api('/api/groups/' + encodeURIComponent(state.group.id) + '/invite');
              showInvite(invite.inviteUrl);
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
              showInvite(invite.inviteUrl);
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
            await startSession(result);
          });

          onSubmit('register-form', async function (form) {
            var result = await api('/api/auth/register', {
              method: 'POST',
              body: {
                displayName: form.displayName.value,
                email: form.email.value,
                password: form.password.value,
              },
            });
            await startSession(result);
          });

          onSubmit('create-group-form', async function (form) {
            var created = await api('/api/groups', {
              method: 'POST',
              body: { name: form.name.value, revealYear: Number(form.revealYear.value) },
            });
            await loadGroups();
            state.group = created.group;
            state.tab = 'collect';
            notify('Group created. Share the invite link from the members tab.', 'ok');
            render();
          });

          onSubmit('join-form', async function (form) {
            var joined = await api('/api/invites/accept', {
              method: 'POST',
              body: { inviteCode: readInvite(form.inviteCode.value) },
            });
            state.pendingInvite = null;
            await loadGroups();
            state.group = joined.group;
            state.tab = 'collect';
            notify('You joined ' + joined.group.name + '.', 'ok');
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

          onSubmit('quote-form', async function (form) {
            var involved = Array.prototype.slice
              .call(form.querySelectorAll('input[name="involved"]:checked'))
              .map(function (input) { return input.value; });

            await api('/api/groups/' + encodeURIComponent(state.group.id) + '/quotes', {
              method: 'POST',
              body: {
                text: form.text.value,
                saidByMemberId: form.saidByMemberId.value,
                involvedMemberIds: involved,
              },
            });

            await openGroup(state.group.id, 'collect');
            notify('Saved. It is sealed until the reveal.', 'ok');
            render();
          });
        }

        function showInvite(url) {
          var box = document.getElementById('invite-box');
          if (box) {
            box.innerHTML = '<p class="mono small">' + escapeHtml(url) + '</p>';
          }
        }

        /** Accepts either a raw code or a full invite URL pasted from a message. */
        function readInvite(value) {
          var trimmed = (value || '').trim();
          var marker = trimmed.indexOf('invite=');
          return marker === -1 ? trimmed : decodeURIComponent(trimmed.slice(marker + 'invite='.length));
        }

        async function startSession(result) {
          state.token = result.token;
          state.user = result.user;
          localStorage.setItem(TOKEN_KEY, result.token);

          if (state.pendingInvite) {
            try {
              await api('/api/invites/accept', { method: 'POST', body: { inviteCode: state.pendingInvite } });
              notify('You joined the group you were invited to.', 'ok');
            } catch (error) {
              notify('Signed in, but the invite link could not be used: ' + error.message, 'error');
            }
            state.pendingInvite = null;
            history.replaceState({}, '', '/app');
          }

          await loadGroups();
          render();
        }

        async function loadGroups() {
          var account = await api('/api/auth/me');
          state.user = account.user;
          state.groups = account.groups;
        }

        async function openGroup(groupId, tab) {
          try {
            var result = await api('/api/groups/' + encodeURIComponent(groupId));
            state.group = result.group;
            state.tab = tab || 'collect';
            state.reveal = null;
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

        async function boot() {
          if (!state.token) {
            render();
            return;
          }

          try {
            await loadGroups();
            if (state.pendingInvite) {
              await startSession({ token: state.token, user: state.user });
              return;
            }
          } catch (error) {
            if (error.message === 'unauthenticated') {
              return;
            }
            notify(error.message, 'error');
          }

          render();
        }

        boot();
      })();
    </script>
  </body>
</html>`;

export const appHtml = html;

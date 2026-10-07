/**
 * Transactional email through Brevo.
 *
 * Split in two on purpose: `buildResetEmail` is pure and decides what the
 * message says, `sendEmail` is the thin piece that talks to the network. The
 * part worth testing is the part that cannot be tested against a real provider
 * from CI.
 */

export type EmailMessage = {
  to: string;
  toName: string;
  subject: string;
  text: string;
  html: string;
};

export type EmailConfig = {
  apiKey: string;
  fromAddress: string;
  fromName: string;
};

/** Absent configuration is a deployment state, not an error to hide from. */
export const emailConfig = (env: {
  BREVO_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;
}): EmailConfig | null =>
  env.BREVO_API_KEY
    ? {
        apiKey: env.BREVO_API_KEY,
        fromAddress: env.EMAIL_FROM ?? 'no-reply@huelin.dev',
        fromName: env.EMAIL_FROM_NAME ?? 'Quotes Journal',
      }
    : null;

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/**
 * The reset message.
 *
 * It says plainly that ignoring it is safe and that nothing has changed yet,
 * because the person most likely to receive one they did not ask for is someone
 * whose address an attacker typed into the form. It names the hour-long expiry
 * so a link that has gone stale is explicable rather than mysterious.
 */
export const buildResetEmail = (to: string, displayName: string, link: string): EmailMessage => {
  const name = displayName || 'there';
  const text = [
    `Hello ${name},`,
    '',
    'Someone asked to reset the password for your Quotes Journal account.',
    'Open this link within the next hour to choose a new one:',
    '',
    link,
    '',
    'If that was not you, nothing has happened and you can ignore this message.',
    'Your password has not been changed and nobody has been signed in.',
    '',
    'Quotes Journal',
  ].join('\n');

  const html = [
    `<p>Hello ${escapeHtml(name)},</p>`,
    '<p>Someone asked to reset the password for your Quotes Journal account. ',
    'Open this link within the next hour to choose a new one:</p>',
    `<p><a href="${escapeHtml(link)}">Choose a new password</a></p>`,
    `<p style="word-break:break-all">${escapeHtml(link)}</p>`,
    '<p>If that was not you, nothing has happened and you can ignore this message. ',
    'Your password has not been changed and nobody has been signed in.</p>',
    '<p>Quotes Journal</p>',
  ].join('');

  return { to, toName: displayName, subject: 'Reset your Quotes Journal password', text, html };
};

/**
 * Hands one message to Brevo. Returns whether it was accepted rather than
 * throwing: a caller that must not reveal whether an account exists cannot
 * afford to behave differently when a send fails.
 */
export const sendEmail = async (config: EmailConfig, message: EmailMessage): Promise<boolean> => {
  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': config.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: config.fromName, email: config.fromAddress },
        to: [{ email: message.to, name: message.toName || undefined }],
        subject: message.subject,
        textContent: message.text,
        htmlContent: message.html,
      }),
    });

    return response.ok;
  } catch {
    return false;
  }
};

/**
 * The one message this app exists to send: the vault is open.
 *
 * Deliberately says nothing about what is inside. The whole year's point is
 * that nobody reads a quote early, and a preview line in a notification would
 * hand the ending to anyone glancing at a lock screen.
 */
export const buildRevealEmail = (
  to: string,
  displayName: string,
  groupName: string,
  quoteCount: number,
  link: string,
): EmailMessage => {
  const name = displayName || 'there';
  const count = `${quoteCount} ${quoteCount === 1 ? 'quote' : 'quotes'}`;
  const text = [
    `Hello ${name},`,
    '',
    `${groupName} is open.`,
    '',
    `${count} went in over the year, and none of them have been read yet.`,
    'Open the group to read them all, see who said what, and play the quiz:',
    '',
    link,
    '',
    'Quotes Journal',
    'You can turn these off in your settings.',
  ].join('\n');

  const html = [
    `<p>Hello ${escapeHtml(name)},</p>`,
    `<p><strong>${escapeHtml(groupName)} is open.</strong></p>`,
    `<p>${escapeHtml(count)} went in over the year, and none of them have been read yet. `,
    'Open the group to read them all, see who said what, and play the quiz:</p>',
    `<p><a href="${escapeHtml(link)}">Open ${escapeHtml(groupName)}</a></p>`,
    `<p style="word-break:break-all">${escapeHtml(link)}</p>`,
    '<p>Quotes Journal<br />You can turn these off in your settings.</p>',
  ].join('');

  return { to, toName: displayName, subject: `${groupName} is open`, text, html };
};

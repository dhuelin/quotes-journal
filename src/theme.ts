/**
 * The palette, as data.
 *
 * `line` and `field` are separate on purpose. A card's edge is decoration — the
 * card already has its own background — but an input's edge is the only thing
 * saying "this is a box you type in", which WCAG 1.4.11 holds to 3:1. One token
 * for both meant either invisible inputs or heavy-handed card borders.
 *
 * Every colour in the app comes from one of these roles, and nothing in the
 * stylesheet names a hex value. Swapping the look is therefore editing this
 * file and nothing else — which is also what lets `test/theme.test.ts` check
 * every contrast pair automatically, instead of someone measuring by hand and
 * hoping the next change keeps it true.
 *
 * Roles, not colours. `--accent` is "the brand, and the moments worth
 * celebrating"; `--interactive` is "this does something when you press it".
 * They used to be the same gold doing twelve jobs, which is why everything
 * looked equally important.
 *
 * Three shapes recur, and the distinction matters more in light than in dark:
 *   X         a fill, with on-X written on top of it
 *   X-ink     the same idea used as *text*, on the page background
 *   on-X      what is legible on top of the X fill
 * Gold is the reason this split exists: #f8c630 is a fine button fill in both
 * themes, and unreadable as text on white.
 */
export type ThemeRole =
  | 'bg'
  | 'surface'
  | 'surface-2'
  | 'line'
  | 'field'
  | 'text'
  | 'muted'
  | 'accent'
  | 'accent-ink'
  | 'on-accent'
  | 'interactive'
  | 'interactive-ink'
  | 'on-interactive'
  | 'ok'
  | 'ok-ink'
  | 'on-ok'
  | 'danger'
  | 'danger-ink'
  | 'on-danger'
  | 'focus';

export type Theme = Record<ThemeRole, string>;

/** Night sky, one lit lamp. The look the app has always had, with the gold's jobs split. */
export const DARK: Theme = {
  bg: '#0f1020',
  surface: '#191a30',
  'surface-2': '#21223d',
  line: '#32345a',
  field: '#6065a0',
  text: '#f2f2f7',
  muted: '#a2a4c4',

  accent: '#f8c630',
  'accent-ink': '#f8c630',
  'on-accent': '#221d00',

  interactive: '#9db4ff',
  'interactive-ink': '#a9bcff',
  'on-interactive': '#0b142e',

  ok: '#7bdcb5',
  'ok-ink': '#7bdcb5',
  'on-ok': '#06281c',

  danger: '#ff8f8f',
  'danger-ink': '#ff8f8f',
  'on-danger': '#3a0d0d',

  focus: '#a9bcff',
};

/**
 * The same identity in daylight: a cool off-white ground rather than plain
 * white, so cards have something to sit on, and the indigo kept in the text
 * rather than the background.
 */
export const LIGHT: Theme = {
  bg: '#f4f5fa',
  surface: '#ffffff',
  'surface-2': '#eceef7',
  line: '#dfe2ee',
  field: '#7a819c',
  text: '#15162b',
  muted: '#565977',

  accent: '#f8c630',
  'accent-ink': '#6f4e00',
  'on-accent': '#221d00',

  interactive: '#3346c4',
  'interactive-ink': '#2c3da8',
  'on-interactive': '#ffffff',

  ok: '#13784f',
  'ok-ink': '#0f6141',
  'on-ok': '#ffffff',

  danger: '#bc2626',
  'danger-ink': '#a11d1d',
  'on-danger': '#ffffff',

  focus: '#3346c4',
};

const block = (theme: Theme): string =>
  (Object.keys(theme) as ThemeRole[]).map((role) => `--${role}: ${theme[role]};`).join(' ');

/**
 * The themed custom properties.
 *
 * Light is the base on bare `:root`, so a browser that understands nothing
 * still gets a complete palette. Dark arrives two ways: by preference, guarded
 * so an explicit light choice wins, and by an explicit `data-theme`. Defining a
 * colour *only* inside a media query is the bug this shape prevents.
 */
export const themeCss = (): string =>
  [
    `:root { color-scheme: light dark; ${block(LIGHT)} }`,
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; ${block(DARK)} } }`,
    `:root[data-theme="dark"] { color-scheme: dark; ${block(DARK)} }`,
    `:root[data-theme="light"] { color-scheme: light; ${block(LIGHT)} }`,
  ].join('\n      ');

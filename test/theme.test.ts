import { describe, expect, it } from 'vitest';
import { DARK, LIGHT, themeCss, type Theme, type ThemeRole } from '../src/theme';

const luminance = (hex: string): number => {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((raw) => {
    const part = raw / 255;
    return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const contrast = (left: string, right: string): number => {
  const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
};

/**
 * Every pair the stylesheet actually puts together. Listed rather than
 * generated, because most combinations never occur and checking those would
 * only produce failures nobody can act on.
 */
const TEXT_PAIRS: [ThemeRole, ThemeRole][] = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text', 'surface-2'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['muted', 'surface-2'],
  ['accent-ink', 'bg'],
  ['accent-ink', 'surface'],
  ['interactive-ink', 'bg'],
  ['interactive-ink', 'surface'],
  ['interactive-ink', 'surface-2'],
  ['ok-ink', 'surface'],
  ['danger-ink', 'surface'],
  ['on-accent', 'accent'],
  ['on-interactive', 'interactive'],
  ['on-ok', 'ok'],
  ['on-danger', 'danger'],
];

/**
 * Boundaries and controls rather than text, which WCAG 1.4.11 holds to 3:1 —
 * a border nobody can see is a card that has no edge.
 */
const SHAPE_PAIRS: [ThemeRole, ThemeRole][] = [
  // The edge of a box you type in, against the card it sits on — which is what
  // says "there is a control here". Checking it against the input's own fill
  // instead would be the wrong question: that is the colour it encloses, not
  // the one it has to be distinguished from.
  ['field', 'surface'],
  ['field', 'bg'],
  ['focus', 'bg'],
  ['focus', 'surface'],
  ['interactive', 'surface'],
];

/**
 * `line` is deliberately absent above. It separates cards that already have
 * their own background, so it is decoration rather than the thing identifying
 * a component — and forcing it to 3:1 produces borders that shout.
 *
 * `accent` is absent for a different reason: gold is never the sole signal of
 * a state. It is a fill with dark text on it, or it is type, and both of those
 * are covered by the text pairs. Anything that means "this one is selected"
 * uses `interactive`, which is held to 3:1 here.
 */

const themes: [string, Theme][] = [
  ['light', LIGHT],
  ['dark', DARK],
];

describe.each(themes)('the %s theme', (name, theme) => {
  it.each(TEXT_PAIRS)('reads %s on %s at AA', (front, back) => {
    const ratio = contrast(theme[front], theme[back]);
    expect(ratio, `${name}: ${front} on ${back} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SHAPE_PAIRS)('separates %s from %s at 3:1', (front, back) => {
    const ratio = contrast(theme[front], theme[back]);
    expect(ratio, `${name}: ${front} on ${back} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
  });

  it('defines every role, with no holes to fall through', () => {
    for (const [role, value] of Object.entries(theme)) {
      expect(value, role).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('the themed stylesheet', () => {
  it('defines the whole palette on bare :root, not only inside a media query', () => {
    const css = themeCss();
    const base = css.slice(0, css.indexOf('@media'));

    // A colour defined only under `prefers-color-scheme` is missing entirely
    // for anyone whose browser does not match it.
    for (const role of Object.keys(LIGHT)) {
      expect(base, role).toContain(`--${role}:`);
    }
  });

  it('lets an explicit choice beat the system preference, both ways', () => {
    const css = themeCss();

    // Without the :not() guard, someone who picks light on a dark-set OS gets
    // dark anyway — the media query would still match and still apply.
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain(':root[data-theme="light"]');
  });

  it('names roles only, so swapping a theme is editing one file', () => {
    expect(themeCss()).not.toContain('rgb(');
    expect(Object.keys(LIGHT).sort()).toEqual(Object.keys(DARK).sort());
  });
});

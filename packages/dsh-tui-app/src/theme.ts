/**
 * dsh-tui theme: approximates the opencode default dark theme (`opencode.json`)
 * so the terminal looks like opencode TUI. Ink renders hex colors via chalk
 * (truecolor), so the palette below maps 1:1 when the terminal supports 24-bit
 * color (GNOME Terminal/VTE does). The page background stays transparent to
 * respect the terminal background, like opencode's default system behavior.
 *
 * @module @yourname/dsh-tui-app/theme
 */

/** opencode default-dark palette (hex). */
export const theme = {
  /** Near-black page / transcript background (not painted; terminal shows through). */
  bg: '#0a0a0a',
  /** Raised panel background (composer, sidebar, dialogs). */
  panel: '#141414',
  /** Element background (nested surfaces, code inline). */
  element: '#1e1e1e',
  /** Subtle border. */
  borderSubtle: '#3c3c3c',
  /** Border. */
  border: '#484848',
  /** Active border. */
  borderActive: '#606060',
  /** Primary text. */
  text: '#eeeeee',
  /** Muted text (status, hints, secondary). */
  textMuted: '#808080',
  /** Primary accent (user role, links, function/primary). */
  primary: '#fab283',
  /** Secondary accent (agent roles). */
  secondary: '#5c9cf5',
  /** Accent (headings, command highlights). */
  accent: '#9d7cd8',
  /** Success / code. */
  success: '#7fd88f',
  /** Warning / blockquote / type. */
  warning: '#f5a742',
  /** Info / operator. */
  info: '#56b6c2',
  /** Error. */
  error: '#e06c75',
  /** Emphasis / yellow. */
  yellow: '#e5c07b',
} as const

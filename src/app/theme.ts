/**
 * Theme — single source of truth for UI chrome colors.
 *
 * Switch between dark (Tokyo Night) and light (Day) by changing `theme` below.
 * Editor syntax highlighting lives in Editor.ts and uses the Desktop
 * Sonic Pi palette for parity with the canonical IDE — do not unify.
 */

const darkTheme = {
  isDark: true as const,

  // Backgrounds
  bg:          '#1a1b26',
  bgDark:      '#16161e',
  bgDarker:    '#0f0f17',
  bgHighlight: '#292e42',
  bgPanel:     '#1f2335',
  bgAlt:       '#24283b',

  // Foregrounds
  fg:        '#c0caf5',
  fgDark:    '#a9b1d6',
  fgMuted:   '#9aa5ce',
  comment:   '#565f89',
  fgFaint:   '#414868',

  // Borders (translucent so they layer cleanly on any bg)
  border:      'rgba(192,202,245,0.08)',
  borderHover: 'rgba(192,202,245,0.16)',
  borderStrong:'rgba(192,202,245,0.24)',

  // Accent (brand) — Desktop Sonic Pi deeppink (sonicpitheme.cpp dt_pink)
  accent:       '#FF1493',
  accentMuted:  'rgba(255,20,147,0.15)',
  accentHover:  'rgba(255,20,147,0.4)',
  accentDrag:   'rgba(255,20,147,0.6)',
  accentFaint:  'rgba(255,20,147,0.08)',

  // Semantic colors
  blue:   '#7aa2f7',
  cyan:   '#7dcfff',
  purple: '#bb9af7',
  magenta:'#ff9e64',
  green:  '#9ece6a',
  red:    '#f7768e',
  orange: '#e0af68',
  yellow: '#e0af68',

  // Status-specific shortcuts
  success: '#9ece6a',
  warning: '#e0af68',
  error:   '#f7768e',
  info:    '#7aa2f7',

  // Shadow (used for tooltips/popups)
  shadow: 'rgba(0,0,0,0.4)',
  shadowStrong: 'rgba(0,0,0,0.6)',
} as const

const lightTheme = {
  isDark: false as const,

  // Backgrounds
  bg:          '#f5f5f7',
  bgDark:      '#ebebed',
  bgDarker:    '#dcdcdf',
  bgHighlight: '#e0e0e8',
  bgPanel:     '#f0f0f3',
  bgAlt:       '#e8e8ec',

  // Foregrounds
  fg:        '#1a1b26',
  fgDark:    '#2d2e3f',
  fgMuted:   '#4a4b60',
  comment:   '#7a7b95',
  fgFaint:   '#a0a1b5',

  // Borders (translucent so they layer cleanly on any bg)
  border:      'rgba(30,31,50,0.10)',
  borderHover: 'rgba(30,31,50,0.20)',
  borderStrong:'rgba(30,31,50,0.32)',

  // Accent (brand) — Desktop Sonic Pi deeppink
  accent:       '#d6007a',
  accentMuted:  'rgba(214,0,122,0.12)',
  accentHover:  'rgba(214,0,122,0.22)',
  accentDrag:   'rgba(214,0,122,0.40)',
  accentFaint:  'rgba(214,0,122,0.06)',

  // Semantic colors
  blue:   '#2563eb',
  cyan:   '#0891b2',
  purple: '#7c3aed',
  magenta:'#c2410c',
  green:  '#16a34a',
  red:    '#dc2626',
  orange: '#d97706',
  yellow: '#b45309',

  // Status-specific shortcuts
  success: '#16a34a',
  warning: '#d97706',
  error:   '#dc2626',
  info:    '#2563eb',

  // Shadow (used for tooltips/popups)
  shadow: 'rgba(0,0,0,0.12)',
  shadowStrong: 'rgba(0,0,0,0.22)',
} as const

export const theme = lightTheme

export type Theme = typeof darkTheme

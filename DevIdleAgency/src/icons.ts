/**
 * Icônes locales DevIdle Agency (style Game-icons, 100 % gratuit et offline).
 * Fichiers dans public/assets/icons/ (voir https://game-icons.net ou https://github.com/game-icons/icons).
 */

const ICONS_DIR = '/assets/icons';

/** Noms de fichiers SVG locaux (sans .svg) pour chaque usage. */
export const ICON_FILES: Record<string, string> = {
  user: 'user',
  'user-group': 'users',
  'money-bag': 'coins',
  document: 'document',
  error: 'error',
  refresh: 'refresh',
  home: 'home',
  'shopping-cart': 'cart',
  list: 'list',
  flash: 'flash',
  logout: 'logout',
  settings: 'settings',
  student: 'student',
  developer: 'developer',
  'conference-call': 'senior',
  briefcase: 'briefcase',
  contract: 'contract',
  star: 'star',
};

const FALLBACK_FILE = 'placeholder';

/**
 * Retourne le chemin local vers une icône (100 % offline, pas d’API).
 * Utilise les SVG dans public/assets/icons/.
 */
export function getIconPath(name: string): string {
  if (!name || typeof name !== 'string') return `${ICONS_DIR}/${FALLBACK_FILE}.svg`;
  const file = ICON_FILES[name.trim()] ?? name.trim().toLowerCase().replace(/\s+/g, '-');
  return `${ICONS_DIR}/${file}.svg`;
}

/**
 * Compatibilité avec l’ancienne API : retourne toujours le chemin local
 * (taille et options ignorés pour le mode 100 % local).
 */
export function getIconUrl(
  name: string,
  _size?: number,
  _options?: { format?: 'png' | 'svg'; color?: string; platform?: string }
): string {
  return getIconPath(name);
}

/**
 * URL de l’icône de secours (même que getIconPath('placeholder')).
 */
export function getFallbackIconPath(): string {
  return `${ICONS_DIR}/${FALLBACK_FILE}.svg`;
}

export const GAME_ICON_NAMES = {
  user: 'user',
  users: 'user-group',
  briefcase: 'briefcase',
  contract: 'contract',
  error: 'error',
  money: 'money-bag',
  star: 'star',
  refresh: 'refresh',
  home: 'home',
  cart: 'shopping-cart',
  settings: 'settings',
  document: 'document',
  list: 'list',
  flash: 'flash',
  logout: 'logout',
  intern: 'student',
  dev: 'developer',
  senior: 'conference-call',
} as const;

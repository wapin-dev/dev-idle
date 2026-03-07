/// <reference types="vite/client" />

interface Window {
  getIconUrl?(name: string, size?: number, options?: { format?: 'png' | 'svg'; color?: string; platform?: string }): string;
  getIconPath?(name: string): string;
  getFallbackIconPath?(): string;
}

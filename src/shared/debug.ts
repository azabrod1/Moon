declare global {
  interface Window {
    __dbgEnabled?: boolean;
    __dbgLog?: (message: string) => void;
  }
}

function formatExtra(extra: unknown): string {
  if (extra === undefined) return '';
  if (extra instanceof Error) return `${extra.name}: ${extra.message}`;
  if (typeof extra === 'string') return extra;

  try {
    return JSON.stringify(extra);
  } catch {
    return String(extra);
  }
}

function push(level: 'DBG' | 'WARN' | 'ERR', message: string, extra?: unknown) {
  const suffix = formatExtra(extra);
  const line = suffix ? `[${level}] ${message} ${suffix}` : `[${level}] ${message}`;

  if (level === 'ERR') {
    console.error(line, extra);
  } else if (level === 'WARN') {
    console.warn(line, extra);
  } else {
    console.log(line, extra);
  }

  if (typeof window !== 'undefined' && window.__dbgLog) {
    window.__dbgLog(line);
  }
}

export function debugLog(message: string, extra?: unknown) {
  push('DBG', message, extra);
}

export function debugWarn(message: string, extra?: unknown) {
  push('WARN', message, extra);
}

export function debugError(message: string, extra?: unknown) {
  push('ERR', message, extra);
}

export {};

import { globalShortcut } from 'electron';

export interface ShortcutDeps {
  showOrCreateMainWindow: () => Promise<void> | void;
  sniffClipboard: () => Promise<void> | void;
  log: (msg: string) => void;
}

export interface ShortcutBindings {
  show: string;
  sniffClipboard: string;
}

export function defaultBindings(): ShortcutBindings {
  if (process.platform === 'darwin') {
    return { show: 'Command+Shift+G', sniffClipboard: 'Command+Shift+V' };
  }
  return { show: 'Control+Shift+G', sniffClipboard: 'Control+Shift+V' };
}

const registered: string[] = [];

export interface RegisterReport {
  show: { accelerator: string; ok: boolean };
  sniffClipboard: { accelerator: string; ok: boolean };
}

export function registerShortcuts(deps: ShortcutDeps, bindings: ShortcutBindings = defaultBindings()): RegisterReport {
  const tryRegister = (acc: string, fn: () => void): boolean => {
    try {
      const ok = globalShortcut.register(acc, fn);
      if (ok) registered.push(acc);
      else deps.log(`globalShortcut: ${acc} registration declined (likely conflict)`);
      return ok;
    } catch (e) {
      deps.log(`globalShortcut: ${acc} threw: ${(e as Error).message}`);
      return false;
    }
  };

  const okShow = tryRegister(bindings.show, () => { void deps.showOrCreateMainWindow(); });
  const okSniff = tryRegister(bindings.sniffClipboard, () => { void deps.sniffClipboard(); });

  return {
    show: { accelerator: bindings.show, ok: okShow },
    sniffClipboard: { accelerator: bindings.sniffClipboard, ok: okSniff },
  };
}

export function unregisterAllShortcuts(): void {
  while (registered.length > 0) {
    const acc = registered.pop()!;
    try { globalShortcut.unregister(acc); } catch { /* best-effort */ }
  }
  try { globalShortcut.unregisterAll(); } catch { /* best-effort */ }
}

export function isShortcutRegistered(acc: string): boolean {
  try { return globalShortcut.isRegistered(acc); } catch { return false; }
}

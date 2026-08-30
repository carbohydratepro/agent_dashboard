#!/usr/bin/env node
/**
 * ダッシュボードの起動口。
 *   node src/cli.ts [--cwd <dir>] [--home <dir>] [--no-anim] [--no-bell]
 */

import { bootstrap } from './core/bootstrap.ts';
import { defaultRoot } from './core/config.ts';
import { NodeTerminal } from './tui/terminal.ts';
import { App } from './tui/app.ts';
import { DEFAULT_THEME } from './tui/theme.ts';

export interface Options {
  cwd: string;
  home: string;
  animate: boolean;
  bell: boolean;
  ascii: boolean;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    cwd: process.cwd(),
    home: defaultRoot(),
    animate: true,
    bell: true,
    ascii: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cwd') opts.cwd = argv[++i] ?? opts.cwd;
    else if (arg === '--home') opts.home = argv[++i] ?? opts.home;
    else if (arg === '--no-anim') opts.animate = false;
    else if (arg === '--ascii') opts.ascii = true;
    else if (arg === '--no-bell') opts.bell = false;
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const opts = parseArgs(argv);
  const boot = await bootstrap({ root: opts.home, cwd: opts.cwd });

  boot.monitor.start();
  boot.recovery.attach();
  boot.usage.start();

  const terminal = new NodeTerminal();
  const app = new App({
    manager: boot.manager,
    terminal,
    monitor: boot.monitor,
    recovery: boot.recovery,
    theme: DEFAULT_THEME,
    animate: opts.animate && boot.config.ui.animations,
    ascii: opts.ascii || boot.config.ui.ascii,
    availableKinds: boot.availableKinds,
    usage: boot.usage,
    bell: opts.bell && boot.config.notifications.bell,
    defaultCwd: boot.config.defaults.cwd,
    loadHistory: (id) => boot.persistence.loadTasks(id, 20),
    warnings: boot.warnings,
    history: boot.history,
  });

  const shutdown = (): void => {
    boot.monitor.stop();
    boot.usage.stop();
    boot.detachAutosave();
    if (app.running) app.stop();
  };
  app.onExit(() => {
    boot.monitor.stop();
    boot.usage.stop();
    boot.detachAutosave();
    process.exit(0);
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    shutdown();
    console.error(err);
    process.exit(1);
  });

  app.start();
}

if (process.argv[1]?.endsWith('cli.ts')) void main();

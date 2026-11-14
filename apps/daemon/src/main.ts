#!/usr/bin/env node
import { resolve } from 'node:path';
import { createDefaultDaemonRuntime } from './index.js';

const brainArgument = process.argv.slice(2).find((argument) => argument.startsWith('--brain='));
const brainPath = resolve(process.cwd(), brainArgument?.slice('--brain='.length) ?? process.env.TAGA_BRAIN ?? 'brain');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

try {
  await (await createDefaultDaemonRuntime(brainPath)).run(controller.signal);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: 'DAEMON_FAILED', message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 10;
}

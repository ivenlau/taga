#!/usr/bin/env node
import { loadConfig } from '../../../packages/config/src/index.js';
import { createDefaultDaemonRuntime } from './index.js';

const brainArgument = process.argv.slice(2).find((argument) => argument.startsWith('--brain='));
const configArgument = process.argv.slice(2).find((argument) => argument.startsWith('--config='));
const requestedBrain = brainArgument?.slice('--brain='.length) ?? process.env.TAGA_BRAIN;
const loadedConfig = await loadConfig({
  ...(configArgument === undefined ? {} : { configPath: configArgument.slice('--config='.length) }),
  ...(requestedBrain === undefined ? {} : { isolatedBrainPath: requestedBrain, overrides: { paths: { brain: requestedBrain } } }),
});
const brainPath = loadedConfig.config.paths.brain;
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

try {
  await (await createDefaultDaemonRuntime(brainPath, loadedConfig.config)).run(controller.signal);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: 'DAEMON_FAILED', message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 10;
}

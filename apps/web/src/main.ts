#!/usr/bin/env node
import { loadConfig } from '../../../packages/config/src/index.js';
import { startWebServer } from './server.js';

interface WebArgs {
  readonly brain?: string;
  readonly host: string;
  readonly port: number;
}

function parseArgs(argv: readonly string[]): WebArgs {
  let brain: string | undefined;
  let host = '127.0.0.1';
  let port = 7391;
  for (const arg of argv) {
    if (arg.startsWith('--brain=')) brain = arg.slice('--brain='.length);
    else if (arg.startsWith('--host=')) host = arg.slice('--host='.length);
    else if (arg.startsWith('--port=')) {
      const parsedPort = Number(arg.slice('--port='.length));
      if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
        throw new Error(`invalid --port value: ${arg}`);
      }
      port = parsedPort;
    }
  }
  return { ...(brain === undefined ? {} : { brain }), host, port };
}

const args = parseArgs(process.argv.slice(2));
if (args.host !== '127.0.0.1' && args.host !== 'localhost') {
  process.stderr.write('taga web only binds to 127.0.0.1 (local-first); refusing remote host\n');
  process.exit(1);
}
const loadedConfig = await loadConfig({
  ...(args.brain === undefined
    ? {}
    : { isolatedBrainPath: args.brain, overrides: { paths: { brain: args.brain } } }),
});
const brainPath = loadedConfig.config.paths.brain;
const { server, url } = await startWebServer({
  brainPath,
  host: args.host,
  port: args.port,
  semanticMode: loadedConfig.config.retrieval.semantic.mode,
  modelPath: loadedConfig.config.retrieval.semantic.modelPath,
  llm: {
    mode: loadedConfig.config.llm.mode,
    provider: loadedConfig.config.llm.provider,
    endpoint: loadedConfig.config.llm.endpoint,
    model: loadedConfig.config.llm.model,
    timeoutMs: loadedConfig.config.llm.timeoutMs,
    ...(loadedConfig.config.llm.dailyCap === undefined ? {} : { dailyCap: loadedConfig.config.llm.dailyCap }),
    apiKeySet: loadedConfig.config.llm.apiKey !== undefined,
    ...(loadedConfig.config.llm.apiKey === undefined ? {} : { apiKey: loadedConfig.config.llm.apiKey }),
  },
});
process.stdout.write(`taga web workbench listening on ${url} (brain: ${brainPath})\n`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

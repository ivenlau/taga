#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { loadConfig } from '../../../packages/config/src/index.js';
import { LiteMcpServer } from './server.js';

const requestedBrain = process.env.TAGA_BRAIN;
const loadedConfig = await loadConfig({
  ...(requestedBrain === undefined ? {} : { isolatedBrainPath: requestedBrain, overrides: { paths: { brain: requestedBrain } } }),
});
const server = new LiteMcpServer(loadedConfig.config.paths.brain, () => new Date(), loadedConfig.config);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of input) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      continue;
    }
    const isNotification = typeof parsed === 'object' && parsed !== null && !('id' in parsed);
    const response = await server.handle(parsed);
    if (response !== null && !isNotification) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
} finally {
  server.close();
}

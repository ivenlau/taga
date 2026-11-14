#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LiteMcpServer } from './server.js';

const server = new LiteMcpServer(join(process.env.TAGA_BRAIN ?? join(homedir(), '.taga', 'brain')));
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

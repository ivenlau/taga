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
    process.stdout.write(`${JSON.stringify(await server.handle(JSON.parse(line)))}\n`);
  }
} finally {
  server.close();
}

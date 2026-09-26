#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runCLI } from './commands.js';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const result = await runCLI(process.argv.slice(2), { root });
  console.log(result.output);
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
}

#!/usr/bin/env node
import { runCli } from './commands.js';
import type { CliIO } from './output.js';

const io: CliIO = {
  cwd: process.cwd(),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

runCli(process.argv.slice(2), io).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  },
);

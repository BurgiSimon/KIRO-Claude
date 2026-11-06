#!/usr/bin/env node
/**
 * kiro-claude executable entry point. All logic lives in cli/main.ts.
 */
import { main } from '../cli/main.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`kiro-claude: ${msg}\n`);
    process.exitCode = 1;
  },
);

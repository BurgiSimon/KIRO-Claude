#!/usr/bin/env node
/**
 * kiro-claude executable entry point. All logic lives in cli/main.ts; bin/run.ts makes sure the
 * process ends once main() has resolved (abandoned claude children shut down, stdout/stderr
 * drained, stray handles cannot hold it open).
 */
import { main } from '../cli/main.js';
import { runEntry } from './run.js';

runEntry(main, process.argv.slice(2));

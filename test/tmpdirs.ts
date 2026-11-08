/**
 * Cleanup of the temp dirs the shared test helpers create.
 *
 * `node --test` runs every test file in its own process, so a sandbox is removed when the
 * process that made it exits. Set KC_KEEP_TMP=1 to keep them for debugging. A dir that cannot be
 * removed (an immutable file a test made, say) is left in place silently.
 */

import * as fs from 'node:fs';

const roots = new Set<string>();
let hooked = false;

function removeAll(): void {
  for (const dir of roots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // left behind; never fail the test run over cleanup
    }
  }
  roots.clear();
}

/** Remove `dir` (recursively) when this test process exits; returns `dir`. */
export function removeOnExit(dir: string): string {
  if (process.env.KC_KEEP_TMP) return dir;
  roots.add(dir);
  if (!hooked) {
    hooked = true;
    process.on('exit', removeAll);
  }
  return dir;
}

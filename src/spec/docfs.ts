/**
 * kiro-claude's own reads and writes of spec files (review X1): the documents
 * (`requirements.md`, `bugfix.md`, `design.md`, `tasks.md`) and `.config.kiro` of
 * `<workspace>/.kiro/specs/<name>/`, and the spec folders themselves. They follow the rules of the
 * spec-phase write allowance (policy/specwrite.ts, {@link specFileRefusal} and
 * {@link specFolderRefusal}):
 *  - a symbolic link AT a document (or `.config.kiro`) is never followed, also one to another
 *    document of the folder; anything there that is not a regular file is refused too;
 *  - a symbolic link above it that resolves to nothing (dangling, a loop) is refused;
 *  - nothing whose real path is outside the workspace is read or written;
 *  - a `.kiro`, `.kiro/specs` or feature folder that is a symbolic link resolving inside the
 *    workspace keeps working.
 * Reads open the file with O_NOFOLLOW and check it on the open descriptor
 * (util/fsx.readRegularFileNoFollow), writes rename over the path itself
 * (util/fsx.writeFileAtomic `followLinks: false`), so a link that appears at the document after
 * the check is not followed either. A link swapped into a FOLDER between the check and the I/O is
 * not ruled out (the same TOCTOU window as the gate's).
 *
 * The workspace a spec path belongs to is read from the path: `<root>` of
 * `<root>/.kiro/specs/<name>/<file>` (every spec path kiro-claude builds has this shape; for any
 * other path the file's own folder is the anchor, so only the link rules apply).
 */

import * as path from 'node:path';
import { specFileRefusal, specFolderRefusal } from '../policy/specwrite.js';
import { readRegularFileNoFollow, writeFileAtomic } from '../util/fsx.js';

/** What a refusal message adds after the reason. */
export const SPEC_LINK_RULE =
  'kiro-claude reads and writes spec documents only as regular files inside the workspace and never follows a symbolic link at one (replace it with a regular file, or move the spec folder into the workspace)';

/** The user-visible message for a refused spec file or folder (`why`: the refusal reason). */
export function specRefusalText(why: string): string {
  return `${why}: ${SPEC_LINK_RULE}`;
}

/** Thrown by {@link readSpecFile} / {@link writeSpecFile} for a refused file; `message` is {@link specRefusalText}. */
export class SpecFileRefusedError extends Error {
  readonly code = 'ESPECREFUSED';
  constructor(
    readonly path: string,
    readonly why: string,
  ) {
    super(specRefusalText(why));
    this.name = 'SpecFileRefusedError';
  }
}

/** `<root>` of the spec folder `<root>/.kiro/specs/<name>` (lexically); any other folder is its own anchor. */
export function specFolderRoot(dir: string): string {
  const d = path.resolve(dir);
  const specs = path.dirname(d);
  const kiro = path.dirname(specs);
  return path.basename(specs) === 'specs' && path.basename(kiro) === '.kiro' ? path.dirname(kiro) : d;
}

/** Why kiro-claude must not use the spec folder `dir` (specwrite.specFolderRefusal), else undefined. */
export function specFolderRefused(dir: string): string | undefined {
  const d = path.resolve(dir);
  return specFolderRefusal(d, specFolderRoot(d));
}

/**
 * Why kiro-claude must not use `<workspaceRoot>/.kiro/specs` itself (specwrite.specFolderRefusal:
 * a `.kiro` or `.kiro/specs` linked out of the workspace or to nothing), else undefined. Such a
 * folder is not even listed: its entries are another folder's.
 */
export function specsRootRefused(workspaceRoot: string): string | undefined {
  const root = path.resolve(workspaceRoot);
  return specFolderRefusal(path.join(root, '.kiro', 'specs'), root);
}

/** Why kiro-claude must not read or write the spec file `file` (specwrite.specFileRefusal), else undefined. */
export function specFileRefused(file: string): string | undefined {
  const p = path.resolve(file);
  return specFileRefusal(p, specFolderRoot(path.dirname(p)));
}

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

/**
 * The text of the spec file `file` as stored (a BOM kept), undefined when it does not exist.
 * Throws {@link SpecFileRefusedError} when it is refused, also when a link or a non-regular file
 * appears there after the check; other errors (EACCES, …) are thrown as they are.
 */
export function readSpecFile(file: string): string | undefined {
  const p = path.resolve(file);
  const why = specFileRefused(p);
  if (why) throw new SpecFileRefusedError(p, why);
  try {
    return readRegularFileNoFollow(p);
  } catch (e) {
    const code = errCode(e);
    if (code === 'ELOOP') throw new SpecFileRefusedError(p, `${p} is a symbolic link`);
    if (code === 'EFTYPE' || code === 'EISDIR') throw new SpecFileRefusedError(p, `${p} is not a regular file`);
    throw e;
  }
}

/**
 * Atomically replace the spec file `file` with `text` (folders created as needed). Throws
 * {@link SpecFileRefusedError} when it is refused; the rename replaces the path itself, never a
 * link's target.
 */
export function writeSpecFile(file: string, text: string): void {
  const p = path.resolve(file);
  const why = specFileRefused(p);
  if (why) throw new SpecFileRefusedError(p, why);
  writeFileAtomic(p, text, { followLinks: false });
}

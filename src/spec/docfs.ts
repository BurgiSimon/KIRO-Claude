/**
 * kiro-claude's own reads and writes of spec files (review X1): the documents
 * (`requirements.md`, `bugfix.md`, `design.md`, `tasks.md`) and `.config.kiro` of
 * `<workspace>/.kiro/specs/<name>/`, and the spec folders themselves. They follow the rules of the
 * spec-phase write allowance (policy/specwrite.ts, {@link specFileRefusal} and
 * {@link specFolderRefusal}):
 *  - a symbolic link AT a document (or `.config.kiro`) is never followed, also one to another
 *    document of the folder; anything there that is not a regular file is refused too;
 *  - a symbolic link above it that resolves to nothing (dangling, a loop) is refused, and so is
 *    one whose target cannot be accessed (realpath fails with EACCES or EPERM: a folder on the
 *    way the user cannot enter), with that reason and an advice of its own
 *    ({@link SPEC_LINK_ACCESS_RULE}: replacing the link or moving the folder would not help);
 *  - nothing whose real path is outside the workspace is read or written;
 *  - a document the user cannot read (whatever its size), and a feature folder or `.kiro/specs`
 *    it cannot enter (also one a link points at, or one under such a folder), is refused with
 *    `<p> cannot be accessed (permission denied)` and an advice of its own
 *    ({@link SPEC_ACCESS_RULE}), never taken for a missing one (r7 #6);
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

import * as fs from 'node:fs';
import * as path from 'node:path';
import { deniedWhy, isAccessRefusal, isLinkAccessRefusal, specFileRefusal, specFolderRefusal } from '../policy/specwrite.js';
import { readRegularFileNoFollow, writeFileAtomic } from '../util/fsx.js';

/** `<p> cannot be accessed (permission denied)`: the reason for a spec file or folder the user cannot access. */
export { deniedWhy } from '../policy/specwrite.js';

/** What a refusal message adds after the reason (any reason but {@link SPEC_LINK_ACCESS_RULE}'s and {@link SPEC_ACCESS_RULE}'s). */
export const SPEC_LINK_RULE =
  'kiro-claude reads and writes spec documents only as regular files inside the workspace and never follows a symbolic link at one (replace it with a regular file, or move the spec folder into the workspace)';

/**
 * What a refusal message adds after a reason that a symbolic link's target cannot be accessed
 * (policy/specwrite.isLinkAccessRefusal), instead of {@link SPEC_LINK_RULE}.
 */
export const SPEC_LINK_ACCESS_RULE =
  'kiro-claude uses spec files behind a symbolic link only when it can resolve the link and check that it leads inside the workspace';

/**
 * What a refusal message adds after a reason that a spec file or folder itself (or a folder above
 * it) cannot be accessed (policy/specwrite.isAccessRefusal), instead of {@link SPEC_LINK_RULE}.
 */
export const SPEC_ACCESS_RULE =
  'kiro-claude uses spec files and folders only when it can read them, and never takes one it cannot read for a missing one (check their permissions)';

/** The user-visible message for a refused spec file or folder (`why`: the refusal reason). */
export function specRefusalText(why: string): string {
  return `${why}: ${isLinkAccessRefusal(why) ? SPEC_LINK_ACCESS_RULE : isAccessRefusal(why) ? SPEC_ACCESS_RULE : SPEC_LINK_RULE}`;
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
 * a `.kiro` or `.kiro/specs` linked out of the workspace, to nothing or to a target that cannot
 * be accessed, or a `.kiro/specs` the user cannot enter), else undefined. Such a
 * folder is not even listed: its entries are another folder's (or cannot be reached).
 */
export function specsRootRefused(workspaceRoot: string): string | undefined {
  const root = path.resolve(workspaceRoot);
  return specFolderRefusal(path.join(root, '.kiro', 'specs'), root);
}

/**
 * Why `<workspaceRoot>/.kiro/specs` is not used or cannot be listed: {@link specsRootRefused}, or a
 * `.kiro/specs` the user may enter but not read (EACCES or EPERM), whose entries cannot be
 * enumerated (its specs can still be used by their exact name); else undefined.
 */
export function specsListRefused(workspaceRoot: string): string | undefined {
  const why = specsRootRefused(workspaceRoot);
  if (why) return why;
  const specs = path.join(path.resolve(workspaceRoot), '.kiro', 'specs');
  try {
    fs.accessSync(specs, fs.constants.R_OK);
  } catch (e) {
    const code = errCode(e);
    if (code === 'EACCES' || code === 'EPERM') return deniedWhy(specs);
  }
  return undefined;
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
 * appears there after the check, or the open fails with EACCES or EPERM (the user cannot read
 * it: never taken for a missing file); other errors are thrown as they are.
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
    if (code === 'EACCES' || code === 'EPERM') throw new SpecFileRefusedError(p, deniedWhy(p));
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

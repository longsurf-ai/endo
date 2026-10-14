// Purpose: Declare shipped read-only originals in the default Workspace.

/**
 * Lowercase relative paths of read-only originals that the application ships into
 * the default Workspace. Writes, removals and renames of these paths (or folders
 * holding them) fail with WorkspaceFileProtected; `installBuiltin` restores them.
 * Empty by default: an application adds paths here when it seeds protected files.
 * @example builtinPaths.has("templates/report.md");
 */
export const builtinPaths: ReadonlySet<string> = new Set<string>();

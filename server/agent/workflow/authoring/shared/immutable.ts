// Purpose: Detaches and freezes snapshots shared by authoring and workflow execution.

/**
 * Freezes a detached execution snapshot, including nested arrays and objects.
 * @example
 * const snapshot = immutable({rows: ['AAPL']});
 */
export function immutable<A>(value: A): A {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== "object") return;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
  };
  freeze(copy);
  return copy;
}

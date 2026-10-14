// Purpose: Immediately-invoked function expression helper
// Module:  @openchart/utils

export function iife<T>(fn: () => T) {
  return fn();
}

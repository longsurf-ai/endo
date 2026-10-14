// Purpose: Evaluates ordered permission rules with wildcard matching.

import type { Rule, Ruleset } from "./types";

/**
 * Matches an entire resource or action, normalizing Windows separators.
 * A trailing command-space-star also matches the command without arguments.
 * @example
 * const allowedCommand = match('git', 'git *'); // true
 */
export function match(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp(
    "^" + escaped + "$",
    process.platform === "win32" ? "si" : "s",
  ).test(normalized);
}

/**
 * Returns the last matching rule, or an ask decision when none matches.
 * @example
 * const rule = evaluate('read', '/notes/a.md', rules);
 */
export function evaluate(
  action: string,
  resource: string,
  ...rulesets: Ruleset[]
): Rule {
  return (
    rulesets
      .flat()
      .reverse()
      .find(
        (rule) => match(action, rule.action) && match(resource, rule.resource),
      ) ?? { action, resource: "*", decision: "ask" }
  );
}

/**
 * Concatenates rules in precedence order without changing their patterns.
 * @example
 * const rules = merge(defaultRules, configuredRules);
 */
export function merge(...rulesets: Ruleset[]): Ruleset {
  return rulesets.flat();
}

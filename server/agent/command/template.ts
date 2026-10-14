/** Template output and captured placeholder values for a command's Part builder. */
export interface Expansion {
  readonly expandedText: string;
  readonly captures: Readonly<Record<string, string>>;
}

/** Extracts argument hints from the template. @example hints('$1 $2'); */
export function hints(template: string) {
  const result: string[] = [];
  const numbered = template.match(/\$\d+/g);
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match);
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS");
  return result;
}

/**
 * Applies quoted arguments, last-position rest capture, raw
 * $ARGUMENTS replacement and no-placeholder append. Does no shell or file I/O.
 * @example expandTemplate('$1 $2', '3 research this company');
 */
export function expandTemplate(
  templateCommand: string,
  argumentsText: string,
): Expansion {
  const raw = argumentsText.match(argsRegex) ?? [];
  const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""));

  const placeholders = templateCommand.match(placeholderRegex) ?? [];
  let last = 0;
  for (const item of placeholders) {
    const value = Number(item.slice(1));
    if (value > last) last = value;
  }

  const captures: Record<string, string> = {};
  const withArgs = templateCommand.replaceAll(
    placeholderRegex,
    (_, index: string) => {
      const position = Number(index);
      const argIndex = position - 1;
      const value =
        argIndex >= args.length
          ? ""
          : position === last
            ? args.slice(argIndex).join(" ")
            : (args[argIndex] ?? "");
      captures[`$${index}`] = value;
      return value;
    },
  );
  const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS");
  if (usesArgumentsPlaceholder) captures.$ARGUMENTS = argumentsText;
  let template = withArgs.replaceAll("$ARGUMENTS", argumentsText);

  if (
    placeholders.length === 0 &&
    !usesArgumentsPlaceholder &&
    argumentsText.trim()
  ) {
    template = template + "\n\n" + argumentsText;
  }
  return { expandedText: template.trim(), captures };
}

/**
 * Encodes a highest-position capture back into quoted arguments. Splitting only
 * on ASCII spaces preserves whitespace within tokens and empty joined tokens.
 * A token containing both quote kinds cannot come from this argument compiler;
 * returns undefined for that unsupported input. Does not change tokenization.
 * @example formatRestArgument('Research "Apple"');
 */
export function formatRestArgument(text: string): string | undefined {
  const tokens = text.split(" ");
  if (tokens.some((token) => token.includes('"') && token.includes("'")))
    return undefined;
  return tokens
    .map((token) =>
      token && !/[\s"']/.test(token)
        ? token
        : token.includes('"')
          ? `'${token}'`
          : `"${token}"`,
    )
    .join(" ");
}

// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi;
const placeholderRegex = /\$(\d+)/g;
const quoteTrimRegex = /^["']|["']$/g;

// Preserve assistant-ui's directive syntax, adding escaping for literal filename delimiters.
type DirectiveItem = { type: string; label: string; id: string };
type DirectiveSegment =
  { kind: "text"; text: string } | ({ kind: "mention" } & DirectiveItem);

const directive =
  /:([\w-]{1,64})\[((?:\\.|[^\]\\\n])+)\](?:\{name=((?:\\.|[^}\\\n])+)\})?/gu;

function escape(value: string): string {
  return value.replace(/[\\\]}\n\r]/g, (char) =>
    char === "\n" ? "\\n" : char === "\r" ? "\\r" : `\\${char}`,
  );
}

function unescape(value: string): string {
  return value.replace(/\\([\\\]}nr])/g, (_, char: string) =>
    char === "n" ? "\n" : char === "r" ? "\r" : char,
  );
}

/** One formatter for picking, editing and displaying file references and command drafts. */
export const directiveFormatter = {
  serialize: (item: DirectiveItem) =>
    `:${item.type}[${escape(item.label)}]{name=${escape(item.id)}}`,
  parse(text: string) {
    const segments: DirectiveSegment[] = [];
    let offset = 0;
    for (const match of text.matchAll(directive)) {
      if (match.index > offset)
        segments.push({ kind: "text", text: text.slice(offset, match.index) });
      const label = unescape(match[2]!);
      segments.push({
        kind: "mention",
        type: match[1]!,
        label,
        id: match[3] === undefined ? label : unescape(match[3]),
      });
      offset = match.index + match[0].length;
    }
    if (offset < text.length)
      segments.push({ kind: "text", text: text.slice(offset) });
    return segments;
  },
};

/** Reads a leading chip and preserves its suffix verbatim. @example const leading = readLeadingDirective(draft.text); */
export function readLeadingDirective(text: string) {
  const match = text.matchAll(directive).next().value;
  if (!match || match.index !== 0) return undefined;
  const [item] = directiveFormatter.parse(match[0]);
  return item?.kind === "mention"
    ? { item, rest: text.slice(match[0].length) }
    : undefined;
}

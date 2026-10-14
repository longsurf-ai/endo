// Purpose: Compiles shared prompt segments into guarded system prompt strings

/** Values substituted into prompt variables and conditional sections. */
export type PromptTemplateContext = Record<
  string,
  boolean | number | string | null | undefined
>;

/** A text asset path, optionally included only when a context value is truthy. */
export type PromptManifestPart =
  | string
  | {
      path: string;
      when?: string;
    };

/** Ordered prompt sections and the name used to identify compilation errors. */
export type PromptManifest = {
  name: string;
  parts: readonly PromptManifestPart[];
};

/** Explicit mapping from manifest paths to loaded text assets. */
export type PromptSegmentRegistry = Record<string, string>;

/**
 * Renders sections in manifest order using V1 template and XML guard semantics.
 * Missing segments, invalid or duplicate tags, and closing guard collisions fail.
 * @example
 * const prompt = compilePrompt({
 *   manifest: {name: 'example', parts: ['identity.txt']},
 *   registry: {'identity.txt': 'You are {{name}}.'},
 *   context: {name: 'OpenChart'},
 * });
 */
export function compilePrompt(input: {
  manifest: PromptManifest;
  registry: PromptSegmentRegistry;
  context?: PromptTemplateContext;
}) {
  const context = input.context ?? {};
  const tags = new Set<string>();
  const sections: string[] = [];

  for (const item of input.manifest.parts) {
    const part = typeof item === "string" ? { path: item } : item;
    if (part.when && !isTruthy(context[part.when])) continue;

    const tag = tagName(part.path);
    if (tags.has(tag)) {
      throw new Error(
        `Duplicate prompt segment tag "${tag}" in ${input.manifest.name}`,
      );
    }
    tags.add(tag);

    const source = input.registry[part.path];
    if (source === undefined) {
      throw new Error(
        `Prompt segment "${part.path}" not found in ${input.manifest.name}`,
      );
    }

    const content = renderTemplate(source, context).trim();
    if (content.includes(`</${tag}>`)) {
      throw new Error(
        `Prompt segment "${part.path}" contains its own closing guard </${tag}>`,
      );
    }
    sections.push(`<${tag}>\n${content}\n</${tag}>`);
  }

  return sections.join("\n\n");
}

/**
 * Derives a lowercase XML guard from an asset basename, rejecting invalid tags.
 * @example
 * tagName('./segments/resources.txt'); // 'resources'
 */
export function tagName(segmentPath: string) {
  const filename = segmentPath.split("/").at(-1) ?? segmentPath;
  const tag = filename.replace(/\.[^.]+$/, "");
  if (!/^[a-z][a-z0-9_]*$/.test(tag)) {
    throw new Error(`Invalid prompt segment tag "${tag}"`);
  }
  return tag;
}

/**
 * Substitutes V1 variables and conditional blocks; absent and false values are empty.
 * @example
 * renderTemplate('Hello {{name}}', {name: 'OpenChart'}); // 'Hello OpenChart'
 */
export function renderTemplate(source: string, context: PromptTemplateContext) {
  const conditional = source.replace(
    /{{#if\s+([a-zA-Z_][a-zA-Z0-9_]*)}}([\s\S]*?){{\/if}}/g,
    (_, key: string, content: string) =>
      isTruthy(context[key]) ? content : "",
  );
  return conditional.replace(
    /{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g,
    (_, key: string) => stringify(context[key]),
  );
}

function isTruthy(value: PromptTemplateContext[string]) {
  if (typeof value === "string") return value.trim().length > 0;
  return Boolean(value);
}

function stringify(value: PromptTemplateContext[string]) {
  if (value === null || value === undefined || value === false) return "";
  if (value === true) return "true";
  return String(value);
}

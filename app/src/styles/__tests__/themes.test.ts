// Purpose: Enforce shared theme defaults, complete scopes, and generated token resolution.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import postcss from "postcss";

const themes = readFileSync("src/styles/themes.css", "utf8");
const globals = readFileSync("src/styles/globals.css", "utf8");

const declarations = (rule: postcss.Rule) => {
  const values = new Map<string, string>();
  rule.walkDecls(/^--/, ({ prop, value }) => {
    if (values.has(prop)) throw new Error(`Duplicate token: ${prop}`);
    values.set(prop, value);
  });
  return values;
};

const scopes: postcss.Rule[] = [];
postcss.parse(themes).walkRules((rule) => {
  scopes.push(rule);
});
const palettes = scopes.filter((rule) =>
  declarations(rule).has("--background"),
);
const shared = scopes.find((rule) => !declarations(rule).has("--background"))!;
const foundation = new Map<string, string>();
postcss.parse(globals).walkRules(":root", (rule) => {
  declarations(rule).forEach((value, key) => foundation.set(key, value));
});

test("light and dark declare the same semantic palette", () => {
  expect(palettes).toHaveLength(2);
  const names = palettes.map((rule) => [...declarations(rule).keys()].sort());
  expect(names[0]).toEqual(names[1]);
  expect(names[0]).toEqual(
    expect.arrayContaining([
      "--background",
      "--foreground",
      "--indicator-blue",
      "--indicator-muted",
      "--chart-grid",
      "--chart-annotation-fill",
      "--chart-agent-annotation-positive",
      "--sidebar",
      "--scrollbar-thumb",
    ]),
  );
});

test("shared theme keeps Gray surfaces and Neutral primary colors", () => {
  expect(declarations(palettes[0]!).get("--background")).toBe("oklch(1 0 0)");
  expect(declarations(palettes[1]!).get("--background")).toBe(
    "oklch(0.18 0 0)",
  );
  expect(declarations(palettes[0]!).get("--sidebar")).toBe("#f1f1f1");
  expect(declarations(palettes[1]!).get("--sidebar")).toBe("#171717");
  expect(declarations(palettes[0]!).get("--primary")).toBe("oklch(0.205 0 0)");
  expect(declarations(palettes[0]!).get("--primary-foreground")).toBe(
    "oklch(0.985 0 0)",
  );
  expect(declarations(palettes[1]!).get("--primary")).toBe("oklch(0.922 0 0)");
  expect(declarations(palettes[1]!).get("--primary-foreground")).toBe(
    "oklch(0.205 0 0)",
  );
  expect(
    shared.selector
      .split(",")
      .map((selector) => selector.trim())
      .sort(),
  ).toEqual([".dark", ".light", ":root"]);
  expect(declarations(shared).get("--sidebar-background")).toBe(
    "var(--sidebar)",
  );
  expect(foundation.get("--font-sans")).toBe('"Inter", sans-serif');
  expect(foundation.get("--font-size-base")).toBe("16px");
  expect(foundation.get("--text-sm")).toBe(
    "calc(var(--font-size-base) * 0.875)",
  );
  expect(foundation.get("--radius-md")).toBe("calc(var(--radius) - 2px)");
});

test("neutral agent annotation leaders stay visible on the light canvas", () => {
  const light = declarations(palettes[0]!);
  expect(light.get("--chart-agent-annotation-neutral")).toBe(
    light.get("--unchanged"),
  );
});

test.each(palettes)(
  "$selector resolves every token without missing values or cycles",
  (palette) => {
    const layers = [foundation, declarations(shared), declarations(palette)];
    const values = new Map(layers.flatMap((layer) => [...layer]));
    expect(values.size).toBe(
      layers.reduce((total, layer) => total + layer.size, 0),
    );
    const resolved = new Set<string>();
    const visit = (key: string, path: string[]) => {
      if (path.includes(key))
        throw new Error(`Token cycle: ${[...path, key].join(" -> ")}`);
      if (resolved.has(key)) return;
      const value = values.get(key);
      if (value === undefined) throw new Error(`Unresolved token: ${key}`);
      for (const [, dependency] of value.matchAll(/var\((--[\w-]+)/g)) {
        visit(dependency!, [...path, key]);
      }
      resolved.add(key);
    };
    values.forEach((_value, key) => visit(key, []));
  },
);

test("generated utilities resolve their application tokens", () => {
  const cli = createRequire(import.meta.url).resolve("tailwindcss/lib/cli.js");
  const css = execFileSync(
    process.execPath,
    [
      cli,
      "--input",
      "src/styles/globals.css",
      "--config",
      "tailwind.config.cjs",
    ],
    {
      encoding: "utf8",
    },
  );
  const tokens = new Set<string>();
  postcss.parse(css).walkDecls(/^--/, (declaration) => {
    tokens.add(declaration.prop);
  });
  const unresolved = [...css.matchAll(/var\((--[\w-]+)/g)]
    .map((match) => match[1]!)
    .filter(
      (token) => !token.startsWith("--tw-") && !token.startsWith("--radix-"),
    )
    // Component-local properties supplied inline by the sidebar, Shiki, Base UI, ToggleGroup, Sonner and FullCalendar events.
    .filter(
      (token) =>
        ![
          "--fc-event-color",
          "--fc-event-contrast-color",
          "--sidebar-width",
          "--sidebar-width-icon",
          "--skeleton-width",
          "--shiki-light",
          "--shiki-dark",
          "--anchor-width",
          "--available-height",
          "--transform-origin",
          "--collapsible-panel-height",
          "--gap",
          "--width",
          "--offset-right",
          "--offset-left",
          "--offset-top",
          "--offset-bottom",
          "--z-index",
          "--toasts-before",
          "--front-toast-height",
          "--offset",
          "--initial-height",
          "--swipe-amount-y",
          "--swipe-amount-x",
          "--mobile-offset-right",
          "--mobile-offset-left",
          "--mobile-offset-bottom",
          "--mobile-offset-top",
        ].includes(token),
    )
    .filter((token) => !tokens.has(token));

  expect(unresolved).toEqual([]);
}, 15_000);

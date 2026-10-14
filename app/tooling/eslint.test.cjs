// Purpose: Verify config discovery, formatting separation, and framework/dependency checks.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { ESLint } = require("eslint");
const prettier = require("prettier");

const appDirectory = path.resolve(__dirname, "..");
// import/no-cycle needs an existing module path; lintText never writes this file.
const probePath = path.join(
  appDirectory,
  "src/components/ui/button/button.tsx",
);
const tailwindConfig = path.join(appDirectory, "tailwind.config.cjs");
const unknownClassRule = "tailwindcss/no-custom-classname";
const eslint = new ESLint({ cwd: appDirectory });

test("shared App rejects native Electron imports", async () => {
  const eslint = new ESLint({ cwd: appDirectory });
  for (const specifier of ["electron", "electron/main", "@openchart/desktop"]) {
    const [result] = await eslint.lintText(`import '${specifier}';\n`, {
      filePath: probePath,
    });
    assert.ok(
      result.messages.some(
        (message) => message.ruleId === "no-restricted-imports",
      ),
    );
  }
});

test("app lint accepts individual Hugeicons through the shared Icon", async () => {
  const result =
    await lint(`import Search01Icon from '@hugeicons/core-free-icons/Search01Icon';

import { Icon } from '@openchart/app/components/ui/icon';

export const Probe = () => <Icon icon={Search01Icon} />;
`);
  assert.deepEqual(result.messages, []);
});

async function lint(source) {
  const [result] = await eslint.lintText(source, { filePath: probePath });
  return result;
}

function temporaryProject(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openchart-lint-"));
  fs.symlinkSync(
    path.join(appDirectory, "node_modules"),
    path.join(directory, "node_modules"),
    "dir",
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runLint(source) {
  const result = spawnSync(
    "npm",
    [
      "run",
      "--silent",
      "lint",
      "--",
      "--stdin",
      "--stdin-filename",
      probePath,
      "--format",
      "json",
    ],
    { cwd: appDirectory, input: source, encoding: "utf8", timeout: 30_000 },
  );
  assert.ifError(result.error);
  return result;
}

test("generated build CSS cannot whitelist an invalid utility", async (t) => {
  const directory = temporaryProject(t);
  fs.mkdirSync(path.join(directory, "dist"));
  fs.writeFileSync(
    path.join(directory, "dist/stale.css"),
    ".bg-stale-build-token { background: red; }",
  );
  const originalDirectory = process.cwd();
  try {
    process.chdir(directory);
    const eslint = new ESLint({
      cwd: appDirectory,
      overrideConfig: { settings: { tailwindcss: { config: tailwindConfig } } },
    });
    const [result] = await eslint.lintText(
      'export const Probe = () => <div className="bg-stale-build-token" />;\n',
      { filePath: probePath },
    );
    assert.ok(
      result.messages.some((message) => message.ruleId === unknownClassRule),
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

const validSource = `import {Slot} from '@radix-ui/react-slot';

import {cn} from '@openchart/app/utils/cn';

export const Probe = () => (
  <Slot className={cn('h-control bg-primary hover:bg-primary-hover')} />
);

export const DestructiveProbe = () => (
  <Slot className={cn('bg-destructive hover:bg-destructive-hover')} />
);
`;

test("the real lint command accepts app aliases and semantic tokens", () => {
  const result = runLint(validSource);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("typed lint rejects unhandled promises", async () => {
  const result = await lint("export function probe() { Promise.resolve(); }");
  assert.ok(
    result.messages.some(
      (message) => message.ruleId === "@typescript-eslint/no-floating-promises",
    ),
  );
});

test("Prettier alone owns formatting and Tailwind class order", async () => {
  const source = 'export const Probe=()=> <div className="p-4 flex" />';
  const result = await lint(source);
  assert.deepEqual(result.messages, []);
  const options = await prettier.resolveConfig(probePath);
  const formatted = await prettier.format(source, {
    ...options,
    filepath: probePath,
  });
  assert.match(formatted, /className="flex p-4"/);
  assert.notEqual(formatted, source);
  assert.equal(
    await prettier.check(formatted, { ...options, filepath: probePath }),
    true,
  );
});

test("React Hooks checks stay enabled", async () => {
  const result = await lint(
    "import {useState} from 'react'; export function Probe({enabled}: {enabled: boolean}) { if (enabled) useState(0); return null; }",
  );
  assert.ok(
    result.messages.some(
      (message) => message.ruleId === "react-hooks/rules-of-hooks",
    ),
  );
});

test("shared UI cannot import application composition", async () => {
  const result = await lint(
    "import {App} from '@openchart/app/app'; export const probe = App;",
  );
  assert.ok(
    result.messages.some(
      (message) => message.ruleId === "import/no-restricted-paths",
    ),
  );
});

test("features cannot import other features", async () => {
  const [result] = await eslint.lintText(
    "import {AgentView} from '@openchart/app/features/agent/components/agent-view/agent-view'; export const probe = AgentView;",
    {
      filePath: path.join(
        appDirectory,
        "src/features/workspace/components/workspace-view.tsx",
      ),
    },
  );
  assert.ok(
    result.messages.some(
      (message) => message.ruleId === "import/no-restricted-paths",
    ),
  );
});

test("features never import the platform", async () => {
  const filePath = path.join(
    appDirectory,
    "src/features/schedule/api/queries.ts",
  );
  for (const source of [
    "import 'electron';",
    "import {app} from 'electron/main'; export const probe = app;",
  ]) {
    const [result] = await eslint.lintText(source, { filePath });
    assert.ok(
      result.messages.some(
        (message) => message.ruleId === "no-restricted-imports",
      ),
      `${source}: ${JSON.stringify(result.messages)}`,
    );
  }
});

for (const [name, expression] of [
  ["JSX", '<div className="CLASS_NAMES" />'],
  ["cn", "cn('CLASS_NAMES')"],
  [
    "cva variants",
    "cva('', { variants: { tone: { danger: 'CLASS_NAMES' } } })",
  ],
]) {
  test(`app lint rejects invalid Tailwind utilities in ${name}`, async () => {
    const result = await lint(
      `export const probe = ${expression.replace("CLASS_NAMES", "bg-lint-missing")};\n`,
    );
    assert.ok(
      result.messages.some((message) => message.ruleId === unknownClassRule),
      JSON.stringify(result.messages),
    );
  });
}

for (const directory of [
  appDirectory,
  path.dirname(appDirectory),
  path.join(appDirectory, "src"),
]) {
  test(`Prettier CLI uses the OpenChart policy from ${path.relative(appDirectory, directory) || "."}`, () => {
    const cli = path.join(
      path.dirname(require.resolve("prettier/package.json")),
      "bin/prettier.cjs",
    );
    const result = spawnSync(
      process.execPath,
      [cli, "--stdin-filepath", probePath],
      {
        cwd: directory,
        input: "export const Probe=()=> <div className='p-4 flex' />",
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      'export const Probe = () => <div className="flex p-4" />;\n',
    );
  });

  test(`editor lint uses shared OpenChart configuration with process cwd ${path.relative(appDirectory, directory) || "."}`, async () => {
    const originalDirectory = process.cwd();
    try {
      process.chdir(directory);
      const eslint = new ESLint({ cwd: directory });
      const [valid] = await eslint.lintText(validSource, {
        filePath: probePath,
      });
      assert.deepEqual(valid.messages, []);
      assert.equal(
        await eslint.isPathIgnored(path.join(appDirectory, "dist/index.tsx")),
        true,
      );

      const [invalid] = await eslint.lintText(
        "export const probe = cn('p-4 flex bg-lint-missing');\n",
        { filePath: probePath },
      );
      const rules = invalid.messages.map((message) => message.ruleId);
      assert.ok(rules.includes(unknownClassRule));
      assert.ok(!rules.includes("tailwindcss/classnames-order"));
    } finally {
      process.chdir(originalDirectory);
    }
  });
}

test("one editor lint instance observes added and removed Tailwind tokens", async (t) => {
  const directory = temporaryProject(t);
  const config = path.join(directory, "tailwind.config.cjs");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  function writeConfig(colors) {
    now += 20_000;
    fs.writeFileSync(
      config,
      `module.exports = ${JSON.stringify({ content: [], theme: { extend: { colors } } })};`,
    );
    fs.utimesSync(config, new Date(now), new Date(now));
  }
  writeConfig({});
  const eslint = new ESLint({
    cwd: appDirectory,
    overrideConfig: { settings: { tailwindcss: { config, cssFiles: [] } } },
  });
  const source =
    'export const Probe = () => <div className="bg-editor-added" />;\n';

  for (const [colors, expectedInvalid] of [
    [{}, true],
    [{ "editor-added": "#123456" }, false],
    [{}, true],
  ]) {
    writeConfig(colors);
    const [result] = await eslint.lintText(source, { filePath: probePath });
    assert.equal(
      result.messages.some((message) => message.ruleId === unknownClassRule),
      expectedInvalid,
      `Tailwind config ${JSON.stringify(colors)}: ${JSON.stringify(result.messages)}`,
    );
  }
});

test("plugin inputs import only schema primitives and Part modules", async () => {
  const filePath = path.resolve(
    appDirectory,
    "../server/agent/contracts/parts/plugin-input-part.ts",
  );
  for (const [source, forbidden] of [
    ["import {Schema} from 'effect'; export const probe = Schema;", false],
    [
      "import {PartBase} from './part-base'; export const probe = PartBase;",
      false,
    ],
    [
      "import {Session} from '@openchart/server/agent/session'; export const probe = Session;",
      true,
    ],
  ]) {
    const [result] = await eslint.lintText(source, { filePath });
    assert.equal(
      result.messages.some(
        (message) => message.ruleId === "no-restricted-imports",
      ),
      forbidden,
      JSON.stringify(result.messages),
    );
  }
});

for (const [file, source, rule] of [
  [
    "server/agent/contracts/session.ts",
    "import {Effect} from 'effect'; export const probe = Effect;",
    "no-restricted-imports",
  ],
  [
    "server/agent/processor/processor.ts",
    "import '@ag-ui/core';",
    "no-restricted-imports",
  ],
  [
    "server/agent/workflow/templates/best-of-n.workflow.ts",
    "export const probe = fetch('https://example.invalid');",
    "no-restricted-globals",
  ],
]) {
  test(`OpenChart dependency boundaries stay active in ${file}`, async () => {
    const [result] = await eslint.lintText(source, {
      filePath: path.resolve(appDirectory, "..", file),
    });
    assert.ok(
      result.messages.some((message) => message.ruleId === rule),
      JSON.stringify(result.messages),
    );
  });
}

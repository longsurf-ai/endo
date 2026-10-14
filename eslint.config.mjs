// V2 owns correctness checks and dependency boundaries. Prettier owns formatting.
import path from "node:path";

import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import hooks from "eslint-plugin-react-hooks";
import a11y from "eslint-plugin-jsx-a11y";
import imports from "eslint-plugin-import";
import tailwind from "eslint-plugin-tailwindcss";
import playwright from "eslint-plugin-playwright";
import testingLibrary from "eslint-plugin-testing-library";
import jestDom from "eslint-plugin-jest-dom";
import vitest from "eslint-plugin-vitest";

const root = import.meta.dirname;
const app = path.join(root, "app");
const tests = ["**/*.test.ts", "**/*.test.tsx", "**/*.typecheck.ts"];
const agentInternals = {
  group: ["@openchart/server/agent/contracts/parts/*"],
  message:
    "Concrete Parts are internal; import @openchart/server/agent/contracts/part.",
};
const resourceImports = [
  agentInternals,
  {
    regex: "^@openchart/server/agent(?:$|/(?!schema$|contracts/))",
    message: "Resources consume Agent contracts; execution belongs to Agent.",
  },
];
const schemaImports = {
  name: "effect",
  allowImportNames: ["Schema", "SchemaGetter", "Struct"],
  message: "Agent contracts use Effect only for schema definitions.",
};

const platformImports = {
  group: [
    "electron",
    "electron/*",
    "@openchart/desktop",
    "@openchart/desktop/*",
    "**/platform/**",
  ],
  message: "Shared App receives platform capabilities through composition.",
};
// Keep directory boundaries declarative; all checks use ESLint's built-in rule.
function restrictImports(files, options, ignores = []) {
  return {
    files,
    ignores,
    rules: { "no-restricted-imports": ["error", options] },
  };
}

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.artifacts/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "**/blob-report/**",
      "**/playwright/.cache/**",
      "**/e2e/.auth/**",
      "**/public/mockServiceWorker.js",
      "**/*.js",
      "**/*.cjs",
      "**/*.mjs",
    ],
  },
  {
    // Absolute scope also works when the repository-root config re-exports this one.
    basePath: root,
    files: ["{app,common,server,platform,demo}/**/*.{ts,tsx}"],
    extends: defineConfig([
      js.configs.recommended,
      tseslint.configs.recommended,
      {
        languageOptions: {
          parserOptions: { projectService: true, tsconfigRootDir: root },
        },
        rules: { "@typescript-eslint/no-floating-promises": "error" },
      },
      {
        files: ["app/*.ts", "app/e2e/**/*.ts"],
        // Build and E2E scripts are outside the app's production TypeScript project.
        extends: [tseslint.configs.disableTypeChecked],
      },
      { files: tests, rules: { "no-constant-condition": "off" } },
      {
        files: ["app/**/*.{ts,tsx}"],
        extends: [
          react.configs.flat.recommended,
          react.configs.flat["jsx-runtime"],
          a11y.flatConfigs.recommended,
        ],
        plugins: {
          "react-hooks": hooks,
          import: imports,
          tailwindcss: tailwind,
        },
        settings: {
          react: { version: "detect" },
          "import/resolver": {
            typescript: { project: path.join(app, "tsconfig.json") },
          },
          tailwindcss: {
            config: path.join(app, "tailwind.config.cjs"),
            callees: ["cn", "classnames", "clsx", "ctl", "cva", "tv"],
            cssFiles: [path.join(app, "src/**/*.css")],
          },
        },
        rules: {
          ...hooks.configs.recommended.rules,
          "react/prop-types": "off", // TypeScript owns props.
          "tailwindcss/no-custom-classname": "error",
          "tailwindcss/no-contradicting-classname": "error",
          "import/no-cycle": "error",
          "import/no-restricted-paths": [
            "error",
            {
              basePath: app,
              zones: [
                ...["agent", "schedule", "workspace"].map((feature) => ({
                  target: `./src/features/${feature}`,
                  from: "./src/features",
                  except: [`./${feature}`],
                })),
                { target: "./src/features", from: "./src/app" },
                {
                  target: [
                    "./src/components",
                    "./src/hooks",
                    "./src/lib",
                    "./src/stores",
                    "./src/types",
                    "./src/utils",
                  ],
                  from: ["./src/features", "./src/app"],
                },
              ],
            },
          ],
        },
      },
      {
        files: ["app/**/*.test.{ts,tsx}"],
        extends: [
          testingLibrary.configs["flat/react"],
          jestDom.configs["flat/recommended"],
          vitest.configs.recommended,
        ],
      },
      {
        files: ["app/e2e/**/*.ts"],
        extends: [playwright.configs["flat/recommended"]],
      },
      restrictImports(["app/**/*.{ts,tsx}"], {
        patterns: [platformImports],
      }),
      // A later rule replaces earlier options for the same files, so repeat the platform ban.
      restrictImports(["app/src/features/**/*.{ts,tsx}"], {
        patterns: [platformImports],
      }),
      restrictImports(
        ["server/agent/contracts/**/*.ts"],
        {
          paths: [schemaImports],
          patterns: [
            {
              regex:
                "^(?!effect$|\\./[^./][^/]*$|@openchart/server/agent/contracts/|@openchart/identifier$|@openchart/models/model-tiers$|@openchart/agent/prompt-constraint$)",
              message:
                "Agent contracts contain schemas; execution and storage stay outside contracts.",
            },
          ],
        },
        tests,
      ),
      restrictImports(
        [
          "server/agent/contracts/part.ts",
          "server/agent/contracts/parts/**/*.ts",
        ],
        {
          paths: [schemaImports],
          patterns: [
            {
              regex:
                "^(?!effect$|(?:\\./|@openchart/server/agent/contracts/parts/)(?:part-base|[a-z-]+-part)$)",
              message:
                "Part schemas import primitives and direct Parts, never their consumers.",
            },
          ],
        },
        tests,
      ),
      restrictImports(["server/agent/contracts/parts/part-base.ts"], {
        paths: [schemaImports],
        patterns: [
          {
            regex: "^(?!effect$)",
            message: "Shared primitives only depend on Effect Schema.",
          },
        ],
      }),
      restrictImports(
        [
          "{app,server,platform,demo}/**/*.{ts,tsx}",
          "common/{identifier,models,utils}/**/*.ts",
        ],
        {
          patterns: [agentInternals],
        },
        ["app/**", "server/agent/contracts/**"],
      ),
      restrictImports(
        ["server/resources/**/*.ts", "server/lib/resource/**/*.ts"],
        { patterns: resourceImports },
        tests,
      ),
      restrictImports(
        ["server/resources/macros/**/*.ts"],
        {
          patterns: [
            ...resourceImports,
            {
              group: [
                "drizzle-orm",
                "drizzle-orm/**",
                "@openchart/server/db",
                "@openchart/server/db/**",
                "**/store",
                "**/store.ts",
                "**/schema",
                "**/schema.ts",
              ],
              message:
                "Macros compose Resource transitions; SQL belongs to Resource stores.",
            },
          ],
        },
        tests,
      ),
      {
        files: ["server/resources/macros/**/*.ts"],
        ignores: tests,
        rules: {
          "no-restricted-properties": [
            "error",
            {
              property: "store",
              message:
                "Macros use Resource transitions, never the underlying store.",
            },
          ],
        },
      },
      {
        files: ["server/**/*.ts"],
        ignores: tests,
        rules: {
          "no-restricted-syntax": [
            "error",
            ...[
              "ImportDeclaration[source.value=/^zod($|\\/)/]",
              "ExportNamedDeclaration[source.value=/^zod($|\\/)/]",
              "ExportAllDeclaration[source.value=/^zod($|\\/)/]",
              "ImportExpression[source.value=/^zod($|\\/)/]",
              "CallExpression[callee.name='require'][arguments.0.value=/^zod($|\\/)/]",
              "TSImportType[source.value=/^zod($|\\/)/]",
            ].map((selector) => ({
              selector,
              message: "These contracts use Effect Schema, not Zod.",
            })),
          ],
        },
      },
      restrictImports(
        ["server/agent/**/*.ts"],
        {
          patterns: [
            agentInternals,
            {
              regex: "(^@ag-ui/|(?:^|/)agui(?:/|$))",
              message:
                "Only the router and publisher select the AG-UI adapter.",
            },
          ],
        },
        [
          "server/agent/contracts/**",
          "server/agent/publisher/agui/**",
          "server/agent/router.ts",
          ...tests,
          "**/*.test-utils.ts",
        ],
      ),
      restrictImports(["server/agent/command/commands/**/*.ts"], {
        patterns: [
          {
            group: [
              "@openchart/server/agent/workflow",
              "@openchart/server/agent/workflow/*",
            ],
            message:
              "Commands declare their own arguments; workflow files own execution.",
          },
        ],
      }),
      restrictImports(["server/agent/workflow/templates/**/*.workflow.ts"], {
        patterns: [
          {
            regex: "^(?!@openchart/workflow$)",
            message: "Workflow programs import only the authoring API.",
          },
        ],
      }),
      {
        files: [
          "server/agent/contracts/**/*.ts",
          "server/agent/workflow/templates/**/*.workflow.ts",
        ],
        ignores: tests,
        rules: {
          "no-restricted-syntax": [
            "error",
            ...[
              "ImportExpression",
              "CallExpression[callee.name='require']",
              "TSImportEqualsDeclaration",
              "TSImportType",
            ].map((selector) => ({
              selector,
              message: "Use static imports through the public contract.",
            })),
          ],
        },
      },
      {
        files: ["server/agent/workflow/templates/**/*.workflow.ts"],
        rules: {
          "no-restricted-globals": [
            "error",
            "process",
            "fetch",
            "globalThis",
            "global",
            "require",
            "Buffer",
          ],
        },
      },
      prettier,
    ]),
  },
);

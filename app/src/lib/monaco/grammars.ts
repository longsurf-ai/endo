// Purpose: Register the bundled TextMate grammars that Workspace files infer their language from.
import { whenReady as typescript } from "@codingame/monaco-vscode-typescript-basics-default-extension";
import { whenReady as python } from "@codingame/monaco-vscode-python-default-extension";
import { whenReady as json } from "@codingame/monaco-vscode-json-default-extension";
import { whenReady as yaml } from "@codingame/monaco-vscode-yaml-default-extension";
import { whenReady as markdown } from "@codingame/monaco-vscode-markdown-basics-default-extension";
import { whenReady as sql } from "@codingame/monaco-vscode-sql-default-extension";
import { whenReady as shell } from "@codingame/monaco-vscode-shellscript-default-extension";
import { whenReady as javascript } from "@codingame/monaco-vscode-javascript-default-extension";
import { whenReady as html } from "@codingame/monaco-vscode-html-default-extension";
import { whenReady as css } from "@codingame/monaco-vscode-css-default-extension";
import { whenReady as r } from "@codingame/monaco-vscode-r-default-extension";
import { whenReady as ini } from "@codingame/monaco-vscode-ini-default-extension";
import { whenReady as log } from "@codingame/monaco-vscode-log-default-extension";

/**
 * Resolve once every bundled grammar is registered. Monarch tokenizers do not
 * color under the TextMate service, so a language without a grammar here shows
 * as plain text; add its `@codingame/monaco-vscode-*-default-extension` here.
 * @example await grammarsReady();
 */
export const grammarsReady = () =>
  Promise.all([
    typescript(),
    python(),
    json(),
    yaml(),
    markdown(),
    sql(),
    shell(),
    javascript(),
    html(),
    css(),
    r(),
    ini(),
    log(),
  ]);

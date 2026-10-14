// Purpose: Keep financial prose, shell variables and code intact around model-generated math.
import { expect, test } from "vitest";

import { preprocessMath } from "@openchart/app/features/agent/components/thread/transcript/markdown/markdown-math";

test("normalizes math while preserving money, shell variables and code", () => {
  expect(
    preprocessMath(
      "Price $100 and $HOME.\n\\[x^2\\]\n`$VALUE`\n```sh\necho $HOME\n```",
    ),
  ).toBe(
    "Price \\$100 and \\$HOME.\n$$\nx^2\n$$\n`$VALUE`\n```sh\necho $HOME\n```",
  );
});

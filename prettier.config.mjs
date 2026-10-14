import path from "node:path";
import * as tailwind from "prettier-plugin-tailwindcss";

// One formatting policy for V2, including editor and code-generation output.
export default {
  plugins: [tailwind],
  tailwindConfig: path.join(import.meta.dirname, "app/tailwind.config.cjs"),
  tailwindFunctions: ["cn", "classnames", "clsx", "ctl", "cva", "tv"],
};

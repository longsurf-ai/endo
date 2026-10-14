/// <reference types="vite/client" />

declare module "virtual:workflow-types" {
  const declarations: {
    entry: string;
    files: { filePath: string; content: string }[];
  };
  export default declarations;
}

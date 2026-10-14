// Purpose: Defines the directory registry with intrinsic reads and explicit registration transitions.

import { defineResource } from "@openchart/server/lib/resource/definition";
import { register } from "@openchart/server/resources/workspace/transitions/register";
import { forget } from "@openchart/server/resources/workspace/transitions/forget";
import { createLocal } from "@openchart/server/resources/workspace/transitions/create-local";
import { getDefault } from "@openchart/server/resources/workspace/transitions/get-default";

import { WorkspaceEntity } from "./entity";
import { workspaceStore } from "./store";

export { WorkspaceEntity, WorkspaceId } from "./entity";

/** Registered directories expose intrinsic reads and explicit directory registration mutations. */
export const workspaceResource = defineResource({
  name: "workspace",
  description:
    "A registered local directory used for files, scripts, workflows, and artifacts. Read its root to locate the directory, then use file tools to access its contents.",
  readOnly: true,
  entity: WorkspaceEntity,
  store: workspaceStore,
  transitions: { register, forget, createLocal, getDefault },
});

/** Complete directory registration returned by Resource reads. */
export type Workspace = typeof workspaceResource.entity.Type;

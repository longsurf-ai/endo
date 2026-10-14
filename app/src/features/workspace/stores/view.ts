// Purpose: Persist which registered Workspace one view shows; never file or registry data.
import { z } from "zod";
import { persist } from "zustand/middleware";
import { createStore, type StoreApi } from "zustand/vanilla";

const viewState = z.object({
  /** The registration this view last showed; a forgotten one falls back to the default. */
  workspaceId: z.string().optional(),
});

/** One view's presentation; losing it only returns the view to the default Workspace. */
export type WorkspaceViewState = z.infer<typeof viewState>;

/** A view-scoped presentation store. */
export type WorkspaceViewStore = StoreApi<WorkspaceViewState>;

/**
 * One persisted local store per view: the page shares `page`, each widget uses its
 * placement. Invalid saved state resets to defaults.
 * @example const [view] = useState(() => createWorkspaceViewStore(placementId ?? "page"));
 */
export function createWorkspaceViewStore(key: string): WorkspaceViewStore {
  return createStore<WorkspaceViewState>()(
    persist(() => viewState.parse({}), {
      name: `local:workspace-view:${key}`,
      version: 1,
      merge: (saved, current) => {
        const parsed = viewState.safeParse(saved);
        return parsed.success ? parsed.data : current;
      },
    }),
  );
}

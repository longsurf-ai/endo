// Purpose: Protect local editor drafts through one router blocker and scoped close checks.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useBlocker } from "react-router";
import { Button } from "@openchart/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@openchart/app/components/ui/dialog";

type Changes = {
  register: (scope: string, hasChanges: () => boolean) => () => void;
  close: (scope: string | readonly string[], action: () => void) => void;
  /** Release an accepted draft only after its action succeeds. */
  clear: (scope: string) => void;
};
const ChangesContext = createContext<Changes | null>(null);
/** Read the app's optional draft protection when hosted in the application shell. @example const changes = useUnsavedChanges(); */
export function useUnsavedChanges() {
  return useContext(ChangesContext);
}

/** Share one navigation guard across independently mounted editors. @example <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider> */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const scopes = useRef(new Map<string, () => boolean>());
  const [pending, setPending] = useState<(() => void) | null>(null);
  const hasChanges = () =>
    Array.from(scopes.current.values()).some((check) => check());
  const blocker = useBlocker(hasChanges);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (Array.from(scopes.current.values()).some((check) => check())) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  const value = useMemo<Changes>(
    () => ({
      register(scope, check) {
        scopes.current.set(scope, check);
        return () => {
          scopes.current.delete(scope);
        };
      },
      close(scope, action) {
        const targets = typeof scope === "string" ? [scope] : scope;
        if (targets.some((id) => scopes.current.get(id)?.()))
          setPending(() => action);
        else action();
      },
      clear(scope) {
        scopes.current.delete(scope);
      },
    }),
    [],
  );
  const cancel = () => {
    setPending(null);
    if (blocker.state === "blocked") blocker.reset();
  };
  return (
    <ChangesContext.Provider value={value}>
      {children}
      <Dialog
        open={pending !== null || blocker.state === "blocked"}
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              You have changes that haven’t been saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={cancel}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                pending?.();
                setPending(null);
                if (blocker.state === "blocked") blocker.proceed();
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ChangesContext.Provider>
  );
}

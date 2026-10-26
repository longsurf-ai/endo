// Purpose: Presents one native CLI's discovery and user-started setup lifecycle.
// Uses the shared settings CardItem and form controls.
import { useEffect, useState, type ReactNode } from "react";
import {
  useIsFetching,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Badge } from "@openchart/app/components/ui/badge";
import { Button } from "@openchart/app/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@openchart/app/components/ui/collapsible/collapsible";
import { Switch } from "@openchart/app/components/ui/form/switch";
import { Input } from "@openchart/app/components/ui/input";
import { CardItem } from "@openchart/app/components/ui/settings/card";
import type { AppTransport } from "@openchart/app/lib/transport/transport";
import {
  agentQueryKeys,
  providerSetupQueryOptions,
} from "@openchart/app/lib/agent/queries";
import { NATIVE_PROVIDER_BRANDS } from "@openchart/app/lib/agent/native-provider-brands";
import type { useConfig } from "@openchart/app/hooks/use-config";
import type { ProviderDiscoveryResult } from "@openchart/models/model-provider";
import type { NativeProviderID } from "@openchart/models/model-tiers";
import { ProviderQuotaMeters } from "./provider-quota";

function discoveryDescription(
  state: ProviderDiscoveryResult,
  enabled: boolean,
): ReactNode {
  switch (state.status) {
    case "not_installed":
      return "Download this provider to use it in Endo.";
    case "authentication_required":
      return "Sign in with your provider account.";
    case "ready":
      return (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Badge variant="outline">Ready</Badge>
          <span>
            {enabled
              ? `${state.provider.models.length} models available`
              : "Enable to use this provider."}
          </span>
        </span>
      );
  }
}

/** The setup step a native CLI needs next: cancel, retry, install or sign in; renders nothing once it is ready. Settings and onboarding share it.
 * @example <ProviderSetupAction controls={useNativeProvider(CODEX, transport)} className="w-full" />
 */
export function ProviderSetupAction({
  controls,
  className,
}: {
  controls: ReturnType<typeof useNativeProvider>;
  className?: string;
}) {
  const { discovery, start, cancel, operation, running, disabled } = controls;
  if (running && operation)
    return (
      <Button
        size="sm"
        variant="ghost"
        className={className}
        disabled={cancel.isPending}
        onClick={() => cancel.mutate(operation.id)}
      >
        Cancel
      </Button>
    );
  if (discovery.isError)
    return (
      <Button
        size="sm"
        variant="outline"
        className={className}
        onClick={() => void discovery.refetch()}
      >
        Try again
      </Button>
    );
  switch (discovery.data?.status) {
    case undefined:
      return (
        <Button size="sm" variant="outline" className={className} disabled>
          Checking…
        </Button>
      );
    case "not_installed":
      return (
        <Button
          size="sm"
          className={className}
          disabled={disabled}
          onClick={() => start.mutate("install")}
        >
          Install
        </Button>
      );
    case "authentication_required":
      return (
        <Button
          size="sm"
          className={className}
          disabled={disabled}
          onClick={() => start.mutate("login")}
        >
          {operation?.status === "failed" && operation.action === "login"
            ? "Retry sign-in"
            : "Sign in"}
        </Button>
      );
    case "ready":
      return discovery.data.provider.models.length === 0 ? (
        <Button
          size="sm"
          variant="outline"
          className={className}
          onClick={() => void discovery.refetch()}
        >
          Check again
        </Button>
      ) : null;
  }
}

/** Inspects disabled providers too; Query owns both discovery and setup snapshots.
 * @example <NativeProvider providerID={CODEX} transport={transport} settings={settings} enabled />
 */
export function NativeProvider({
  providerID,
  transport,
  settings,
  enabled,
}: {
  providerID: NativeProviderID;
  transport: AppTransport;
  settings: ReturnType<typeof useConfig>;
  enabled: boolean;
}) {
  const controls = useNativeProvider(providerID, transport);
  const { name, Logo, setupHint } = NATIVE_PROVIDER_BRANDS[providerID];
  const { discovery, quota, running } = controls;
  const ready = !discovery.isError && discovery.data?.status === "ready";
  return (
    <section aria-label={name}>
      <CardItem
        title={
          <span className="inline-flex items-center gap-2">
            <Logo className="size-4 shrink-0" />
            {name}
          </span>
        }
        htmlFor={ready && !running ? `model-${providerID}` : undefined}
        description={
          discovery.isError
            ? "Couldn’t check this provider."
            : discovery.data
              ? discoveryDescription(discovery.data, enabled)
              : "Checking installation and account…"
        }
        descriptionOutside={setupHint}
        actions={
          ready && !running ? (
            <div className="flex items-center gap-4">
              {quota.isError ? (
                <span className="text-xs text-muted-foreground">
                  Usage unavailable
                </span>
              ) : quota.data ? (
                <ProviderQuotaMeters quota={quota.data} />
              ) : null}
              <Switch
                id={`model-${providerID}`}
                checked={enabled}
                disabled={settings.isSaving || !!settings.readError}
                onCheckedChange={(value) =>
                  settings.update({
                    models: { providers: { [providerID]: { enabled: value } } },
                  })
                }
              />
            </div>
          ) : (
            <ProviderSetupAction controls={controls} />
          )
        }
      />
      <SetupProgress providerID={providerID} controls={controls} />
    </section>
  );
}

/** Refreshes all native providers and reports shared progress and failures.
 * @example <RefreshProviders transport={transport} />
 */
export function RefreshProviders({ transport }: { transport: AppTransport }) {
  const client = useQueryClient();
  const queryKey = ["native-provider", transport.url] as const;
  const fetching = useIsFetching({ queryKey });
  const refresh = useMutation({
    mutationFn: () => transport.rpc.models.refresh.mutate(),
    retry: false,
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });
  const checking = refresh.isPending || fetching > 0;
  return (
    <div className="mt-3 border-t border-border/40 pt-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={checking}
        onClick={() => refresh.mutate()}
      >
        {checking ? "Checking…" : "Check again"}
      </Button>
    </div>
  );
}

/** Renders setup output with web links clickable, since some CLIs print their sign-in URL instead of opening a browser. */
function SetupOutput({ text }: { text: string }) {
  return text.split(/(https?:\/\/\S+)/).map((part, index) =>
    index % 2 === 1 ? (
      <a
        key={index}
        href={part}
        target="_blank"
        rel="noreferrer"
        className="text-foreground underline"
      >
        {part}
      </a>
    ) : (
      part
    ),
  );
}

/** Shows active setup output and sign-in input; failed sign-in output is collapsed and has no active links. Renders nothing after success or cancellation. Onboarding reuses it.
 * @example <SetupProgress providerID={CODEX} controls={useNativeProvider(CODEX, transport)} />
 */
export function SetupProgress({
  providerID,
  controls,
}: {
  providerID: NativeProviderID;
  controls: ReturnType<typeof useNativeProvider>;
}) {
  const { name } = NATIVE_PROVIDER_BRANDS[providerID];
  const { operation, running, input, setInput, write } = controls;
  // Success and cancellation speak through the card; only live or failed setup shows here.
  if (!operation || (!running && operation.status !== "failed")) return null;
  const login = operation.action === "login";
  const output =
    operation.output && (!running || login) ? (
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">
        {!running && login ? (
          operation.output
        ) : (
          <SetupOutput text={operation.output} />
        )}
      </pre>
    ) : null;
  return (
    <div className="mt-3">
      <p role="status" className="text-sm text-muted-foreground">
        {!running
          ? login
            ? "Sign-in failed. Please try again."
            : "Setup failed. Review the output and try again."
          : login
            ? "Complete sign-in in your browser. Keep this operation running."
            : operation.output || "Downloading provider…"}
      </p>
      {/* Failed login output is historical; its links and input prompts are no longer active. */}
      {!running && login && output ? (
        <Collapsible key={operation.id}>
          <CollapsibleTrigger render={<Button size="sm" variant="link" />}>
            Error details
          </CollapsibleTrigger>
          <CollapsibleContent>{output}</CollapsibleContent>
        </Collapsible>
      ) : (
        output
      )}
      {running && login ? (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            write.mutate({ id: operation.id, text: input });
          }}
        >
          <label className="sr-only" htmlFor={`login-code-${providerID}`}>
            Authorization code for {name}
          </label>
          <Input
            id={`login-code-${providerID}`}
            autoComplete="off"
            placeholder="Auth Code"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={write.isPending}
            className="min-w-0 flex-1"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={write.isPending}
          >
            Send
          </Button>
        </form>
      ) : null}
    </div>
  );
}

/** One native CLI's discovery, plan usage and setup operation; Query owns server snapshots, only the unsubmitted login input stays local. Onboarding reuses it.
 * @example const { discovery, start } = useNativeProvider(CODEX, transport);
 */
export function useNativeProvider(
  providerID: NativeProviderID,
  transport: AppTransport,
) {
  const client = useQueryClient();
  const discoveryKey = ["native-provider", transport.url, providerID] as const;
  const setupKey = agentQueryKeys.providerSetup(transport.url, providerID);
  const discovery = useQuery({
    queryKey: discoveryKey,
    retry: false,
    queryFn: ({ signal }) =>
      transport.rpc.models.discover.query({ providerID }, { signal }),
  });
  // Plan usage is read on every Settings visit; sharing the discovery key prefix
  // refreshes it with "Check again" and after login.
  const quota = useQuery({
    queryKey: [...discoveryKey, "quota"] as const,
    enabled: discovery.data?.status === "ready",
    staleTime: 0,
    retry: false,
    meta: { errorTitle: "Couldn’t read plan usage" },
    queryFn: ({ signal }) =>
      transport.rpc.models.quota.query({ providerID }, { signal }),
  });
  const setup = useQuery(providerSetupQueryOptions(transport, providerID));
  useEffect(() => {
    const subscription = transport.events.subscribe({
      next: (frame) => {
        if (
          frame.kind === "ready" ||
          (frame.kind === "event" && frame.event.type === "models.changed")
        ) {
          void client
            .invalidateQueries({
              queryKey: ["native-provider", transport.url, providerID],
            })
            .catch(console.error);
        }
      },
      error: console.error,
    });
    return () => subscription.unsubscribe();
  }, [client, providerID, transport]);
  const [input, setInput] = useState("");
  const start = useMutation({
    mutationFn: (action: "login" | "install") =>
      transport.rpc.models.startSetup.mutate({ providerID, action }),
    retry: false,
    onSuccess: (state) => {
      setInput("");
      client.setQueryData(setupKey, state);
    },
    onSettled: () => client.invalidateQueries({ queryKey: setupKey }),
  });
  const cancel = useMutation({
    mutationFn: (id: string) =>
      transport.rpc.models.cancelSetup.mutate({ providerID, id }),
    retry: false,
    onSettled: () => client.invalidateQueries({ queryKey: setupKey }),
  });
  const write = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      transport.rpc.models.writeSetup.mutate({ providerID, id, text }),
    retry: false,
    onSuccess: () => setInput(""),
  });
  const operation = setup.data?.status !== "idle" ? setup.data : undefined;
  const running = operation?.status === "running";
  const disabled = running || start.isPending || discovery.isFetching;
  return {
    discovery,
    quota,
    start,
    cancel,
    write,
    input,
    setInput,
    operation,
    running,
    disabled,
  };
}

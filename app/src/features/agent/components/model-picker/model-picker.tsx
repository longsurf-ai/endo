// Purpose: Supply OpenChart model choices to the assistant-ui model selector.
import { Loader2Icon } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@openchart/app/components/ui/button";
import { useAgentContext } from "@openchart/app/lib/agent/provider";
import { nativeProviderBrand } from "@openchart/app/lib/agent/native-provider-brands";
import {
  ModelSelectorRoot,
  ModelSelectorTrigger,
  ModelSelectorContent,
  ModelSelectorList,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorEffort,
} from "@openchart/app/components/ui/model-selector/model-selector";
import { isModelMenuOption } from "@openchart/app/lib/agent/model-selection";
import type {
  ModelSelection,
  AgentClient,
} from "@openchart/app/lib/agent/client";

type Providers = Awaited<ReturnType<AgentClient["models"]>>;

function isInstallingProvider(
  providerSetup: ReturnType<typeof useAgentContext>["agent"]["providerSetup"],
) {
  return providerSetup.some(
    ({ data }) => data?.status === "running" && data.action === "install",
  );
}

/** Reuse the shared Agent catalog and its loading/error handling for a controlled model choice.
 * @example <AgentModelPicker model={model} onChange={setModel} />
 */
export function AgentModelPicker({
  model,
  onChange,
  disabled = false,
}: Pick<
  ComponentProps<typeof ModelPicker>,
  "model" | "onChange" | "disabled"
>) {
  const {
    agent: { modelProviders, providerSetup },
  } = useAgentContext();
  return (
    <>
      <ModelPicker
        providers={modelProviders.data ?? []}
        model={model}
        onChange={onChange}
        loading={modelProviders.isPending}
        disabled={disabled}
        settingUp={isInstallingProvider(providerSetup)}
      />
      {modelProviders.isError ? (
        <p className="w-full text-sm text-destructive">
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-inherit"
            disabled={disabled}
            onClick={() => void modelProviders.refetch()}
          >
            Retry models
          </Button>
        </p>
      ) : null}
    </>
  );
}

/** Chooses the current conversation's next prompt model; accepted prompts stay unchanged. @example <ModelPicker providers={providers} model={model} onChange={select} /> */
export function ModelPicker({
  providers,
  model,
  onChange,
  loading = false,
  disabled = false,
  settingUp = false,
}: {
  providers: Providers;
  model?: ModelSelection;
  onChange: (model: ModelSelection) => void;
  loading?: boolean;
  disabled?: boolean;
  settingUp?: boolean;
}) {
  const models = providers.flatMap((provider) => {
    const Logo = nativeProviderBrand(provider.id)?.Logo;
    return provider.models.map((entry) => ({
      // Model IDs are unique within a provider, not across the whole catalog.
      id: JSON.stringify([provider.id, entry.id]),
      name: entry.name || entry.id,
      description: provider.name,
      icon: Logo ? <Logo /> : undefined,
      visible: isModelMenuOption(entry),
      selection: { providerID: provider.id, modelID: entry.id },
      efforts: entry.availableVariants?.length
        ? [
            { id: "", name: "Default" },
            ...entry.availableVariants.map((variant) => ({
              id: variant,
              name: variant,
            })),
          ]
        : undefined,
    }));
  });
  return (
    <ModelSelectorRoot
      models={models}
      // Keep an unavailable choice empty; undefined would select the first model.
      value={model ? JSON.stringify([model.providerID, model.modelID]) : ""}
      onValueChange={(id) => {
        const selected = models.find((entry) => entry.id === id);
        if (selected) onChange(selected.selection);
      }}
      effort={model?.selectedVariant ?? ""}
      onEffortChange={(selectedVariant) => {
        if (model)
          onChange({
            providerID: model.providerID,
            modelID: model.modelID,
            ...(selectedVariant ? { selectedVariant } : {}),
          });
      }}
    >
      <ModelSelectorTrigger
        variant="ghost"
        size="sm"
        className="min-w-0 max-w-full"
        disabled={loading || disabled}
      >
        {settingUp ? (
          <span role="status" className="inline-flex items-center gap-1.5">
            <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
            Setting up…
          </span>
        ) : undefined}
      </ModelSelectorTrigger>
      {/* Providers can expose more effort levels than fit on one row. */}
      <ModelSelectorContent
        searchable={false}
        className="[&_[role=radiogroup]]:flex-wrap"
      >
        <ModelSelectorList>
          <ModelSelectorEmpty />
          <ModelSelectorGroup>
            {models
              .filter((entry) => entry.visible)
              .map((entry) => (
                <ModelSelectorItem key={entry.id} model={entry} />
              ))}
          </ModelSelectorGroup>
        </ModelSelectorList>
        <ModelSelectorEffort />
      </ModelSelectorContent>
    </ModelSelectorRoot>
  );
}

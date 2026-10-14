// Purpose: Configure native agent enablement, permission preferences, and the default model.
import { MODEL_PROVIDER_IDS } from "@openchart/models/model-tiers";
import { useOutletContext } from "react-router";

import type { AppRouteContext } from "@openchart/app/app/route-context";
import type { AppConfig } from "@openchart/app/lib/config/config";
import { useAgentContext } from "@openchart/app/lib/agent/provider";
import { isModelMenuOption } from "@openchart/app/lib/agent/model-selection";
import { Card, CardItem } from "@openchart/app/components/ui/settings/card";
import { DropdownControl } from "@openchart/app/components/ui/settings/dropdown-control";
import { useConfig } from "@openchart/app/hooks/use-config";

import { NativeProvider, RefreshProviders } from "./native-provider";
import { SettingsPage } from "./settings-page";

const permissionOptions = [
  { value: "ask", name: "Ask" },
  { value: "auto", name: "Auto" },
  { value: "full-access", name: "Always allow" },
] satisfies Array<{
  value: AppConfig["models"]["permissionMode"];
  name: string;
}>;

/** Configures native providers, shared permissions, and the default model. @example <ModelSettings /> */
export default function ModelSettings() {
  const { transport } = useOutletContext<AppRouteContext>();
  const { agent } = useAgentContext();
  const { modelProviders } = agent;
  const settings = useConfig(transport);
  const config = settings.config;
  const disabled = settings.isSaving || !!settings.readError;
  const choices = (modelProviders.data ?? []).flatMap(
    (provider) => provider.models,
  );
  const selected = config?.models.defaultModel;
  const selectedModel = choices.find(
    (choice) =>
      choice.providerID === selected?.providerID &&
      choice.id === selected?.modelID,
  );
  const value = selected
    ? JSON.stringify([selected.providerID, selected.modelID])
    : "";
  const options = [
    { value: "", name: "First available model" },
    ...(selected && !selectedModel
      ? [
          {
            value,
            name: `${selected.providerID} / ${selected.modelID} (unavailable)`,
          },
        ]
      : []),
    ...choices.filter(isModelMenuOption).map((model) => ({
      value: JSON.stringify([model.providerID, model.id]),
      name: `${model.providerID} / ${model.name}`,
    })),
  ];
  return (
    <SettingsPage title="Models" settings={settings}>
      {config ? (
        <>
          <Card title="Models">
            <CardItem
              title="Default model"
              htmlFor="default-model"
              description="Used until you choose a model in chat."
              className="flex-col items-start gap-y-2 sm:flex-row sm:items-center"
              classNameWrapperAction="w-full sm:w-auto"
              actions={
                <DropdownControl
                  id="default-model"
                  aria-label="Default model"
                  value={value}
                  selectedLabel={
                    selectedModel
                      ? `${selectedModel.providerID} / ${selectedModel.name}`
                      : undefined
                  }
                  options={options}
                  disabled={
                    disabled ||
                    modelProviders.isPending ||
                    modelProviders.isError
                  }
                  onChange={(selectedValue) => {
                    if (selectedValue === value) return;
                    const model = choices.find(
                      (choice) =>
                        JSON.stringify([choice.providerID, choice.id]) ===
                        selectedValue,
                    );
                    settings.update({
                      models: {
                        defaultModel: model
                          ? {
                              providerID: model.providerID,
                              modelID: model.id,
                              selectedVariant: null,
                            }
                          : null,
                      },
                    });
                  }}
                />
              }
            />
            {modelProviders.isPending ? (
              <p role="status" className="mt-3 text-sm text-muted-foreground">
                Discovering models…
              </p>
            ) : null}
            {modelProviders.isError ? (
              <p className="mt-3 text-sm text-destructive">
                <button
                  className="underline"
                  onClick={() => {
                    void modelProviders.refetch();
                  }}
                >
                  Retry
                </button>
              </p>
            ) : null}
            {!modelProviders.isPending &&
            !modelProviders.isError &&
            choices.length === 0 ? (
              <p role="status" className="mt-3 text-sm text-muted-foreground">
                No models are available from the enabled agents.
              </p>
            ) : null}
            <CardItem
              title="Permissions"
              htmlFor="model-permission-mode"
              description="Shared permission preference for all model providers."
              className="flex-col items-start gap-y-2 sm:flex-row sm:items-center"
              classNameWrapperAction="w-full sm:w-auto"
              actions={
                <DropdownControl
                  id="model-permission-mode"
                  aria-label="Permissions"
                  value={config.models.permissionMode}
                  options={permissionOptions}
                  disabled={disabled}
                  onChange={(selectedValue) => {
                    const option = permissionOptions.find(
                      (option) => option.value === selectedValue,
                    );
                    if (
                      !option ||
                      option.value === config.models.permissionMode
                    )
                      return;
                    settings.update({
                      models: { permissionMode: option.value },
                    });
                  }}
                />
              }
            />
          </Card>
          <Card title="Model providers">
            <div className="space-y-6">
              {MODEL_PROVIDER_IDS.map((id) => (
                <NativeProvider
                  key={id}
                  providerID={id}
                  transport={transport}
                  settings={settings}
                  enabled={config.models.providers[id].enabled}
                />
              ))}
            </div>
            <RefreshProviders transport={transport} />
          </Card>
        </>
      ) : null}
    </SettingsPage>
  );
}

// Purpose: Open the first launch by connecting a native agent through Settings' native provider setup.
import {
  ANTIGRAVITY,
  CLAUDE_CODE,
  CODEX,
  GROK,
  OPENCODE,
  type NativeProviderID,
} from "@openchart/models/model-tiers";
import { Check } from "lucide-react";
import { useId } from "react";

import type { OnboardingPageProps } from "@openchart/app/app/trellis/views";
import {
  ProviderSetupAction,
  SetupProgress,
  useNativeProvider,
} from "@openchart/app/app/routes/settings/native-provider";
import {
  AgentMark,
  type AgentMarkId,
} from "@openchart/app/components/ui/brand/agent-marks";
import { Button } from "@openchart/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@openchart/app/components/ui/dialog";
import { NATIVE_PROVIDER_BRANDS } from "@openchart/app/lib/agent/native-provider-brands";

const soon: readonly { agent: AgentMarkId; name: string }[] = [
  { agent: "gemini", name: "Gemini" },
  { agent: "cursor", name: "Cursor" },
  { agent: "githubCopilot", name: "Copilot" },
  { agent: "kimi", name: "Kimi" },
  { agent: "deepSeek", name: "DeepSeek" },
];

type Controls = ReturnType<typeof useNativeProvider>;

function AgentColumn({
  providerID,
  controls,
}: {
  providerID: NativeProviderID;
  controls: Controls;
}) {
  const { name, Logo, setupHint } = NATIVE_PROVIDER_BRANDS[providerID];
  const { discovery, running } = controls;
  const connected =
    !discovery.isError &&
    discovery.data?.status === "ready" &&
    discovery.data.provider.models.length > 0 &&
    !running;
  return (
    <section
      aria-label={name}
      className="flex flex-col items-center gap-4 text-center"
    >
      <Logo className="size-12" />
      <h3 className="font-medium">{name}</h3>
      {setupHint && (
        <p className="text-xs text-muted-foreground">{setupHint}</p>
      )}
      <div className="w-full max-w-56">
        {/* Discovery connects a signed-in CLI on its own; only sign-in or install needs the user. */}
        {connected ? (
          <p className="flex h-8 items-center justify-center gap-2 rounded-md bg-up/10 text-sm font-medium text-up">
            Connected <Check className="size-4" aria-hidden="true" />
          </p>
        ) : (
          <ProviderSetupAction controls={controls} className="w-full" />
        )}
        <div className="text-left">
          <SetupProgress providerID={providerID} controls={controls} />
        </div>
      </div>
    </section>
  );
}

/**
 * The starter workflow's first page: Claude Code, Codex, Antigravity, Grok and OpenCode connect
 * on their own when already signed in, otherwise the user signs in here. Other
 * agents are listed as coming soon. Closing or skipping continues the tour.
 * @example <ConnectAgentsPage transport={transport} onDone={next} />
 */
export function ConnectAgentsPage({ transport, onDone }: OnboardingPageProps) {
  const claude = useNativeProvider(CLAUDE_CODE, transport);
  const codex = useNativeProvider(CODEX, transport);
  const antigravity = useNativeProvider(ANTIGRAVITY, transport);
  const grok = useNativeProvider(GROK, transport);
  const opencode = useNativeProvider(OPENCODE, transport);
  const moreAgents = useId();
  const connected = [claude, codex, antigravity, grok, opencode].some(
    ({ discovery }) =>
      discovery.data?.status === "ready" &&
      discovery.data.provider.models.length > 0,
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onDone()}>
      <DialogContent
        className="gap-8 p-8 sm:max-w-3xl lg:max-w-4xl xl:max-w-4xl"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <div className="space-y-2 text-center">
          <DialogTitle className="text-2xl font-semibold">
            Connect your agent
          </DialogTitle>
          <DialogDescription>
            Endo runs on your favorite agent, with the subscription you already
            have.
          </DialogDescription>
        </div>
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-5">
          <AgentColumn providerID={CLAUDE_CODE} controls={claude} />
          <AgentColumn providerID={CODEX} controls={codex} />
          <AgentColumn providerID={ANTIGRAVITY} controls={antigravity} />
          <AgentColumn providerID={GROK} controls={grok} />
          <AgentColumn providerID={OPENCODE} controls={opencode} />
        </div>
        <section aria-labelledby={moreAgents} className="space-y-5">
          <h3
            id={moreAgents}
            className="flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"
          >
            More agents coming soon
          </h3>
          <ul className="flex flex-wrap justify-center gap-8 text-muted-foreground">
            {soon.map(({ agent, name }) => (
              <li key={agent}>
                <AgentMark
                  agent={agent}
                  role="img"
                  aria-hidden={false}
                  aria-label={name}
                  className="size-7"
                />
              </li>
            ))}
          </ul>
        </section>
        <div className="flex justify-center">
          {connected ? (
            <Button onClick={onDone}>Continue</Button>
          ) : (
            <Button
              variant="link"
              className="text-muted-foreground"
              onClick={onDone}
            >
              Skip for now
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Purpose: Curated copy for new-chat suggestions until recommendations are personalized.
import type { PromptSuggestion } from "./proactive";

/** Fixed suggestions, best first; the app shows a few at a time. Each prompt uses an existing Agent tool. */
export const starterPrompts: readonly PromptSuggestion[] = [
  {
    title: "🗓️  Plan my weekday mornings with a scheduled briefing",
    prompt: `Create an enabled schedule named "Morning plan" that runs every Monday through Friday at 9:00 AM in my local time zone. Ask me for the time zone only if you cannot infer it; otherwise state the one you assumed. The scheduled prompt should review my open conversations from the previous day, list the three most important follow-ups, and propose a short plan for the day. Before creating it, search my existing schedules to avoid a duplicate. After saving, report the schedule by name and id with its next run time.`,
  },
  {
    title: "⏰  Remind me tomorrow to review this conversation",
    prompt: `Create a one-time schedule for tomorrow at 5:00 PM in my local time zone that starts a new conversation reminding me to review the open questions from this chat. Include enough context in the scheduled prompt that it makes sense on its own. Confirm the saved schedule and the exact time it will run.`,
  },
  {
    title: "🧠  Draft three versions of an announcement and pick the best",
    prompt: `Run the best-of-n workflow to draft three independent versions of a short product announcement for a new desktop app that lets people chat with their AI agents and schedule work for later. Compare the drafts on clarity and tone, pick the strongest, and explain why in two sentences.`,
  },
  {
    title: "📋  Review my schedules and pause the stale ones",
    prompt: `List all of my schedules with their next run times and whether they are enabled. Identify schedules that have not produced a run in the past week or look redundant, and propose which to pause. Wait for my confirmation before changing anything.`,
  },
];

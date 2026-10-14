# proactive

Owns what the app offers the user before they ask. Not Agent-specific:
any surface may consume it.

- `proactive.ts` defines each offer's shape and decides what to offer.
  Today prompt suggestions come from the curated `starter-prompts.ts`.
- Offers are read-only. Acting on one goes through its owner; a selected
  prompt is submitted through the normal Agent prompt, never from here.

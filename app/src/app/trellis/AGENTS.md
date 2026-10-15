# Trellis

Onboarding workflows, defined as data and run by `OnboardingHost`.

<!-- HUMAN-ANNOTATION:START -->

- Every workflow lives in its own folder under `workflows/`.
- That folder's only entry point is its top-level `workflow.ts`; arrange
  everything else freely.
- Every action and view a workflow uses extends the common base classes.

<!-- HUMAN-ANNOTATION:END -->

- Copied from OpenChart. Preserve the shared host, progress, action and view
  behavior; register product workflows in `workflows.ts`.
- A step pairs an optional action with a view. Views load UI lazily; the host
  calls their methods and never reaches into product markup.
- `onDone` marks the step seen and runs the next unseen step's action. Leaving
  the page also marks it seen; seeing every step ends the workflow.
- `local:onboarding` stores device-local progress. Desktop seeds `starter`
  before the backend creates a new profile's database. Existing profiles and
  saved browser progress are preserved.
- Endo's starter contains only the agent-connection modal, reusing Settings'
  provider controls. Keep its copied layout and behavior; only the product
  name differs from OpenChart.

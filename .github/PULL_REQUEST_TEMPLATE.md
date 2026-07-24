## Summary

<!-- What does this change do, and why? Link the issue it closes if there is one. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor (no behavior change)
- [ ] Documentation / repo tooling
- [ ] Dependency change (versions pinned, lockfile committed)

## Gate

All four checks pass locally (CI runs the same commands and must stay green):

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run test`
- [ ] `npm run build`

## Tests

- [ ] Added or updated tests for the changed behavior (a bug fix includes a test that fails
      before it), **or** this change does not alter behavior (docs/tooling only).

## Safety invariants

Confirm this change does not weaken the guarantees in `docs/rules.md`:

- [ ] Product writes still happen only in `app/worker/apply.server.ts`, driven by a `queued` job.
- [ ] No job reaches `queued` except from `staged` via the explicit apply intent.
- [ ] Every applied `JobItem` still captures its before-values before the mutation runs.
- [ ] Job status transitions remain guarded (`updateMany` with the expected current status).
- [ ] Relative adjustments still resolve to absolute after-values at staging time.
- [ ] The Admin GraphQL API is still mocked in tests; no new runtime dependency was added
      without approval.

## How verified

<!-- Describe how you tested this beyond the gate: which scenarios, any manual dev-store steps. -->

## Notes for reviewers

<!-- Anything worth calling out: trade-offs, follow-ups, or scope not covered by the PRD. -->

---
name: Bug report
about: Report incorrect behavior in the app
title: "bug: "
labels: bug
assignees: ""
---

## Summary

A clear, one-line description of what is wrong.

## Area

Which part of the app is affected?

- [ ] Product browser / saved filters
- [ ] Edit set builder / preview gate
- [ ] Apply job / worker
- [ ] CSV export
- [ ] CSV import
- [ ] Job history / undo
- [ ] Auth / embedding / webhooks
- [ ] Other

## Steps to reproduce

1.
2.
3.

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Include the per-item outcome or error banner text if a job
failed, and any relevant structured log lines (redact shop domain and IDs if needed).

## Impact on safety invariants

Did any product write happen without a preview, without a captured before-value, or in a
way that could not be undone? If so, describe it — these are treated as high priority.

## Environment

- Commit / version:
- Node version:
- Database (SQLite dev / Postgres prod):
- Where reproduced (local dev store / production):

## Additional context

Screenshots, CSV samples (with sensitive data removed), or anything else that helps.

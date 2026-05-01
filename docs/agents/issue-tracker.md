# Issue Tracker: Local Markdown

Issues for this repository are tracked as markdown files within the `.scratch/` directory, following a feature-based organization.

## Workflow

1.  **Creation:** When a new issue or task is identified, create a new markdown file under `.scratch/<feature-name>/<issue-id>-<short-description>.md`.
2.  **Tracking:** Use the `triage` skill to manage the state of these issues.
3.  **Consumption:** Skills like `to-issues` and `to-prd` will write to this directory, and `triage` will read from it to determine the next steps.

## Directory Structure

```
.scratch/
  <feature-1>/
    001-fix-login-bug.md
    002-add-logout-button.md
  <feature-2>/
    003-implement-search.md
```

## Tools

- `gh` CLI is **NOT** used for this tracker.
- Manual file manipulation or agent-based file edits are the primary way to update issue state.

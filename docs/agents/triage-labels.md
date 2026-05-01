# Triage Labels

This repository uses the default triage label vocabulary to manage the state of issues.

## Label Mapping

| Role | Label | Description |
| :--- | :--- | :--- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate the issue. |
| `needs-info` | `needs-info` | Waiting on the reporter for more information. |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for an AFK agent to implement. |
| `ready-for-human` | `ready-for-human` | Needs human implementation (too complex or sensitive for agents). |
| `wontfix` | `wontfix` | The issue will not be actioned. |

## Usage

The `triage` skill will apply these labels (as strings within the markdown issue files) to track the progression of tasks.

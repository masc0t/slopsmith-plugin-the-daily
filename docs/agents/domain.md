# Domain Documentation

This project follows a single-context documentation layout.

## Context File

- **Path:** `CONTEXT.md` (at repo root)
- **Purpose:** Defines the project's domain language, core concepts, and high-level architecture.

## Architectural Decision Records (ADRs)

- **Path:** `plans/adr/`
- **Purpose:** Records significant architectural decisions and their rationales.

## Usage for Skills

- `improve-codebase-architecture`: Reads `CONTEXT.md` and `plans/adr/` to identify refactoring opportunities aligned with the domain model.
- `diagnose`: Uses `CONTEXT.md` to understand the expected behavior of system components during debugging.
- `tdd`: References `CONTEXT.md` to ensure new features and tests use correct domain terminology.

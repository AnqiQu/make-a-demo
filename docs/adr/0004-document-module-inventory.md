# Document Deep Module Inventory

The module inventory is explicit so future changes preserve deep modules and do not blur seams.

- Core modules: `agent`, `auth`, `config`, `conversations`, `errors`, `memory`, `model`, `settings`, and `tools`.
- Adapter modules: `codex/auth`, `codex/responses`, `file-system`, `memory/simple-linear`, and `tools`.
- App modules: `apps/cli`, including CLI presentation modules and the app-owned composition root.
- Core modules should be deep: callers depend on small public seams while lifecycle policy, replay construction, tool dispatch, and orchestration stay encapsulated behind those seams.
- Adapters should implement public core seams rather than import core implementation modules.
- App composition roots may wire concrete core modules and adapters because startup is where dependency inversion is resolved.
- CLI presentation should depend on CLI seams rather than bypassing the app composition root to reach core or adapters directly.
- Dependency Cruiser enforces these module directions so accidental encapsulation breaks are caught during development.

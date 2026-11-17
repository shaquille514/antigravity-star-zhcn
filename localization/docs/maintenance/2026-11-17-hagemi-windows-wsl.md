# Hagemi integration on Windows with Ubuntu

Target: Antigravity App 2.32.2, Windows x64 desktop, Ubuntu WSL workspace.

Official source reviewed: https://antigravity.google/docs/changelog . The currently retrieved page lists 2.32.1 as its newest App entry; a separate 2.32.2 release-note entry was not available. The local executable reports 2.32.2. These are separate observations, not a claim that the 2.32.2 upstream release notes were verified.

The localization change adds the Hagemi overlay as a protected boundary. The pet also uses the existing generic `data-ag-localization-skip` marker, so protection works with the already running localization engine. Dictionaries, menus, VS Code patches, and original external ASAR resources are unchanged by this boundary change.

The original integration installed only into the Windows profile, while the active language server and plugin manager run in Ubuntu. Ubuntu has Python but no Node, and cannot access the Windows loopback CDP port directly. The installer now selects the active WSL profile. Its native sidecar invokes a small Python bridge that starts the existing Windows Node executable, passes host credentials only through process environment, and translates data paths. The companion can then access both the forwarded Ubuntu language server and the Windows loopback CDP endpoint. No listening address is broadened and no credentials are logged.

Regression tests cover the selected profile, path conversion, initial SSE text, truncated streams, and stopping before response headers. The complete suite passed before deployment, including 55 companion/integration tests and 114 Hagemi tests, plus localization tests and the 45-item static audit. A native helper had to be compiled in the staging directory before its heartbeat test could run.

Real-host acceptance checks are recorded separately after deployment. They may query local model availability and sidecar state, but do not generate a model response or send user conversation excerpts. For a new installation, proactive AI comments are initially disabled in personal settings; manual chat remains available. Existing user choices must be preserved.

The new ASAR is built on a copy of the current client resources, with the 347 external files verified. The live client is left running; the staged resource is applied after a normal exit. The original pristine backup and its SHA-256 are preserved.

## Real-host acceptance

The Ubuntu plugin manager reports `hagemi-pet-agy/pet` as `SIDECAR_STATUS_RUNNING`. Windows Node starts through the Python bridge, and the local model resolver lists 19 models, including 11 Gemini models. No model generation was requested.

The desktop DOM contains Hagemi with the generic localization-skip marker, and the existing wallpaper skin remains applied. A cropped screenshot was inspected. Real-window checks passed for right double-click at 320 ms, input focus, and stopping a synthetic local chat state. A new-conversation reset clears that synthetic state. These checks do not establish a successful cloud model response.

An additional regression test ensures that a pending ASAR is reported even when the current client already has an older localization patch. No forced host shutdown or ASAR replacement occurred while the client was running.

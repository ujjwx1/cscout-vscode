## 1. Backend Pipeline (mostly done, needs wiring)
Done:

cscoco.py — CMake/Meson → .cs file ✓
cscout -s sqlite — analysis → SQLite DB ✓
csapi.py — REST server on DB ✓

Not done:

csapi review comments addressed (fnid, /quit, pagination, docstrings)
csapi PR merged


## 2. Extension Lifecycle (not built)

Detect build system on workspace open
Generate .cs file automatically (call cscoco or csmake)
Run cscout -s sqlite project.cs | sqlite3 project.db
Start csapi.py with the DB
Three-state status bar: Stopped → Analyzing → Ready
Stop everything cleanly on VS Code close (call /quit)
Re-analysis trigger and notifcation to be able to re-run when files change
Error handling at each step with clear user messages


## 3. Extension Settings (not built)

VS Code settings the user can configure:

cscout.binaryPath — path to cscout binary
cscout.port — port for csapi (default 8081)
cscout.autoStart — start on workspace open
cscout.projectName — override auto-detected project name


## 4. Sidebar Panels (partially built in PoC, needs rewiring to csapi)

Identifiers panel — grouped by kind/status, filter controls
Files panel — flat list with RO/writable icons
Functions panel — with fan-in/fan-out counts
All three currently wired to old live CScout API — must rewire to csapi endpoints


## 5. Editor Features (partially built in PoC, needs rewiring)

Hover tooltips — identifier kind, scope, unused status
Go-to-definition (Ctrl+Click) — via /identifier?eid=X locations
Find all references (Shift+F12) — via /identifier?eid=X locations
F2 rename — via /refactor/preview + apply
CodeLens — caller/callee counts above functions
All need rewiring from old API to csapi


## 6. Diagnostics (partially built in PoC)

Unused identifier warnings in Problems panel
Should-be-static warnings
Currently wired to old API — rewire to /identifiers?unused=true and /identifiers?should_be_static=true


## 7. Call Graph (not built properly)

Interactive D3.js ego-centric call graph
Center node, callers left, callees right
Click to re-center on different function
Zoom and pan
Currently just a static list in PoC


## 8. Metrics Views (not built)

File metrics table — sortable, click to navigate
Function metrics table — sortable, click to navigate
Both via /filemetrics and /funmetrics endpoints


## 9. Memory and Performance (not built)

Lazy loading — fetch identifiers on demand, not all upfront
Caching — cache csapi responses in extension memory
Pagination — use limit/offset on all list endpoints
Debouncing — hover requests debounced to avoid flooding csapi
Index readiness — check /status before enabling search features


## 10. Cross-Platform Path Handling (not built properly)

WSL path conversion (partially done in PoC)
Native Linux paths
macOS paths
Windows native paths
Cygwin paths


## 11. Packaging and Distribution (not built)

package.json complete with all commands, settings, activation events
README.md with screenshots and usage guide
VS Code Marketplace packaging (vsce package)
Demo video
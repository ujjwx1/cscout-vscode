# CScout VS Code Extension

A VS Code extension that connects to CScout's REST/JSON API to provide IDE integration for C source code analysis.

<img width="1495" height="1518" alt="Image" src="https://github.com/user-attachments/assets/e9cad6a8-7cc7-44bf-ad9d-0faa85017ccc" />

<img width="1496" height="1528" alt="Image" src="https://github.com/user-attachments/assets/6004595f-babf-403b-8060-324a454a38b1" />

## What This Is

This extension is the **client side** of a two-part system:

1. **CScout REST API** (C++ changes to CScout) — adds JSON endpoints to CScout's built-in SWILL web server
2. **This VS Code extension** — consumes those endpoints and surfaces CScout's analysis in the editor

This is the first implementation where a VS Code extension talks to **real CScout REST endpoints** — not a mock server, not HTML scraping.

## Features

- **Identifier Browser** — all identifiers grouped by kind (function, macro, typedef, tag, member, variable) with unused warnings
- **File Browser** — all analyzed files with read-only/writable status
- **Function Browser** — all functions with fan-in (callers) and fan-out (callees) counts
- **Diagnostics** — unused identifiers appear as warnings in VS Code's Problems panel (whole-program analysis)
- **Go-to-Definition** — Ctrl+Click on any identifier to jump to its definition (via equivalence classes)

## Requirements

- CScout built with REST API endpoints (see the companion PR on the CScout repository)
- Node.js >= 18

## Getting Started

### 1. Build the extension
```bash
npm install
npm run compile
```

### 2. Run CScout on your C project
```bash
cd your-c-project
cscout your-workspace.cs
```

CScout starts its web server on port 8081 with REST/JSON endpoints.

### 3. Launch the extension
```bash
code --extensionDevelopmentPath="$(pwd)" /path/to/your/c/project
```

### 4. Connect

Press `Ctrl+Shift+P` → **CScout: Connect to Server**

The sidebar populates with identifiers, files, and functions. Unused identifiers appear as warnings in the Problems panel.

## REST API Endpoints (served by CScout)

| Endpoint | Description |
|---|---|
| `GET /api/identifiers` | All identifiers with attributes |
| `GET /api/id?id=EID` | Single identifier with all source locations |
| `GET /api/files` | All analyzed files |
| `GET /api/filemetrics?id=FID` | Per-file metrics |
| `GET /api/functions` | All functions with fan-in/fan-out |
| `GET /api/funcs?callers=ID` | Functions calling the given function |
| `GET /api/funcs?callees=ID` | Functions called by the given function |
| `GET /api/projects` | All projects in the workspace |
| `GET /api/projectfiles?projid=PID` | Files belonging to a project |

## Architecture
```
CScout (C++)                    VS Code Extension (TypeScript)
┌─────────────────┐             ┌──────────────────────┐
│ SWILL Web Server│   HTTP/JSON │                      │
│                 │◄────────────│  CScoutClient        │
│ /api/identifiers│             │    │                 │
│ /api/files      │             │    ├─IdentifierTree  │
│ /api/functions  │             │    ├─ FileTree       │
│ /api/id?id=...  │             │    ├─ FunctionTree   │
│ /api/funcs?...  │             │    ├─ Diagnostics    │
│                 │             │    └─ GoToDefinition │
└─────────────────┘             └──────────────────────┘
```

The extension never touches CScout's internals. It communicates exclusively over HTTP, querying JSON endpoints that expose CScout's in-memory data structures.

# CScout VS Code Extension

[![Build and Lint](https://github.com/ujjwx1/cscout-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/ujjwx1/cscout-vscode/actions)

A VS Code extension that connects to [CScout](https://github.com/dspinellis/cscout)'s REST/JSON API for whole-program C source code analysis inside the editor.

## What This Does

CScout performs macro-aware, whole-program analysis of C code — resolving identifiers through the preprocessor, tracking equivalence classes across files, computing per-file and per-function metrics, and building complete call graphs. This extension brings all of that into VS Code.

This is the **client side** of a two-part system:

1. **CScout REST API** ([branch](https://github.com/ujjwx1/cscout/tree/feat/rest-api)) — 10 JSON endpoints added directly to CScout's SWILL web server in C++
2. **This extension** — consumes those endpoints and surfaces the analysis through standard VS Code UI

## Features

### Sidebar Panels
Browse identifiers (grouped by kind — function, macro, typedef, tag, member, variable), files (with read-only/writable status), and functions (with fan-in and fan-out counts). Unused identifiers are flagged with warning icons.

![Extension sidebar showing identifiers, files, and functions](images/sidebar.png)

### Go-to-Definition & Find All References
Ctrl+Click or F12 navigates to definitions. Shift+F12 finds all references. Both resolve through CScout's equivalence classes — giving whole-program precision across all files, including through preprocessor macros.

![Clicking atexit navigates to stdlib.h](images/navigation.png)

### Whole-Program Diagnostics
Unused identifiers detected by CScout's whole-program analysis appear as warnings in VS Code's Problems panel — across every file in the workspace, not just the currently open one.

![Problems panel showing unused identifier warnings](images/diagnostics.png)

### Hover Tooltips
Hover over any identifier to see its kind, scope (project/file/local), unused status, read-only status, and whether it crosses file boundaries.

### CodeLens Annotations
Inline text above function definitions showing how many functions call it and how many functions it calls.

### Refactoring Preview
Select an identifier, run "CScout: Preview Rename", enter a new name — see every file and line that would change before anything is modified. Uses CScout's equivalence classes for whole-program rename precision.
```json
{
  "old_name": "checkdup",
  "new_name": "check_duplicate",
  "affected_files": 1,
  "total_replacements": 3,
  "changes": [{
    "file": "awk/awkgram.y",
    "replacements": [
      {"line": 30, "old": "checkdup", "new": "check_duplicate"},
      {"line": 430, "old": "checkdup", "new": "check_duplicate"},
      {"line": 477, "old": "checkdup", "new": "check_duplicate"}
    ]
  }]
}
```

### Call Graph & Function Metrics
Webview panels for exploring function call graphs (callers and callees) and viewing detailed per-function metrics (lines, complexity, nesting, operators, Halstead volume).

## REST API Endpoints

The extension consumes these endpoints served by CScout:

| Endpoint | Description |
|---|---|
| `GET /api/identifiers` | All identifiers with 17 boolean attributes |
| `GET /api/id?id=EID` | Single identifier with all source locations |
| `GET /api/files` | All analyzed files |
| `GET /api/filemetrics?id=FID` | Per-file metrics |
| `GET /api/functions` | All functions with fan-in/fan-out |
| `GET /api/funmetrics?id=FID` | Per-function metrics |
| `GET /api/funcs?callers=ID` | Callers of a function |
| `GET /api/funcs?callees=ID` | Callees of a function |
| `GET /api/projects` | All projects |
| `GET /api/projectfiles?projid=PID` | Files per project |
| `GET /api/refactor?id=EID&newname=X` | Refactoring preview (dry-run) |

## Getting Started

### 1. Build CScout with REST API
```bash
git clone https://github.com/ujjwx1/cscout.git
cd cscout
git checkout feat/rest-api
make
```

### 2. Run CScout on your C project
```bash
cd your-project
/path/to/cscout your-workspace.cs
```

CScout starts its web server on port 8081 with both HTML and JSON endpoints.

### 3. Build the extension
```bash
cd cscout-vscode
npm install
npm run compile
```

### 4. Launch VS Code with the extension
```bash
code --extensionDevelopmentPath="$(pwd)" /path/to/your/c/project
```

### 5. Connect

Press `Ctrl+Shift+P` → **CScout: Connect to Server**

## Commands

| Command | Description |
|---|---|
| CScout: Connect to Server | Connect to a running CScout instance |
| CScout: Disconnect | Clear all data and disconnect |
| CScout: Refresh | Re-fetch all data |
| CScout: Preview Rename | Preview a whole-program identifier rename |
| CScout: Show Function Metrics | Show metrics for function at cursor |
| CScout: Show Call Graph | Show callers/callees for function at cursor |

## Testing

36 integration tests validate all 11 endpoints against a live CScout process:
```
$ node out/test.js
✓ server is reachable
✓ GET /api/identifiers returns array
✓ identifiers have required fields
...
✓ refactoring preview does not modify files
✓ refactoring preview with invalid EID returns error
36 tests: 36 passed, 0 failed
```

To run tests, start CScout on the awk example, then:
```bash
npm run compile
npm test
```

## Architecture
```
CScout (C++)                    VS Code Extension (TypeScript)
┌─────────────────┐            ┌───────────────────────┐
│ SWILL Web Server│  HTTP/JSON │  CScoutClient         │
│                 │◄─────────  │    │                  │
│ /api/identifiers│            │    ├─IdentifierTree   │
│ /api/files      │            │    ├─ FileTree        │
│ /api/functions  │            │    ├─ FunctionTree    │
│ /api/refactor   │            │    ├─ Diagnostics     │
│                 │            │    ├─ GoToDefinition  │
│ (raw TCP — SWILL│            │    ├─ FindReferences  │
│  sends \n not   │            │    ├─ Hover           │
│  \r\n)          │            │    ├─ CodeLens        │
└─────────────────┘            │    └─ RenamePreview   │
                               └───────────────────────┘
```

## License

GPL-3.0 — same as CScout.
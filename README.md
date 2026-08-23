# CScout for VS Code

[CScout](https://github.com/dspinellis/cscout) is Diomidis Spinellis's C source code analyzer.

This extension puts that analysis inside VS Code itself. Instead of switching windows to look something up, you hover over a variable and see its type, scope, and complexity right there. Go to Definition and Find All References use CScout's analysis. Renaming a variable with F2 follows it correctly through macros and across files, something a plain text-based rename can't do safely in C.

## What it does

- Hover, go to definition, and find references
- Renaming that understands macros and cross-file identifiers
- Diagnostics for unused identifiers and variables that should be `static` but aren't
- CodeLens above each function showing its callers, callees, and complexity
- Sidebar views for identifiers, functions, and files, grouped the same way CScout groups them
- Call graphs and include graphs, when Graphviz is installed

## Setting it up

You need CScout itself installed, along with Python 3 and sqlite3. Graphviz is optional, only needed for the call and include graphs.

Open a C project, CMake, Meson, a Makefile, Autotools, or an existing CScout workspace all work, open the CScout view in the Activity Bar, and hit Start Analysis. The extension figures out your build system, generates the `.cs` workspace file CScout needs, runs the analysis, and starts a small local server the editor talks to for the rest of the session.

If `cscout` isn't on your PATH, set the path directly under Settings, CScout.


## About

I built this as part of Google Summer of Code 2026, to bring CScout's analysis into the editor.

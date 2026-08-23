# Contributing

This started as a Google Summer of Code 2026 project and is now open to outside contributions. Here's how to get set up and send changes back.

## Setup

```
git clone git@github.com:ujjwx1/cscout-vscode.git
cd cscout-vscode
npm install
npm run compile
```

Then open the folder in VS Code and press F5. That launches a second VS Code window (the Extension Development Host) with your build of the extension loaded, so you can try it against a real C project.

To actually exercise the extension end to end, you'll also need CScout itself installed. See the README's "Setting it up" section for that.

## Tests

```
npm test
```

runs the fast tests. They don't need CScout or a server running, so this is what you should run before every commit.

```
npm run test-e2e
```

runs the rest, but these need a live `csapi.py` server backed by a real CScout analysis. By default it looks for CScout checked out as a sibling directory (`../cscout`); set `CSCOUT_PATH` if yours lives somewhere else.

```
npm run lint
```

runs ESLint. CI runs both `npm test` and `npm run lint` on every push, so if either fails locally, it'll fail there too.

## Code style

Worth knowing upfront: indentation is currently inconsistent across the codebase, some files use tabs, some use spaces. A proper formatter to fix this is planned but not set up yet. Until then, match whatever style the file you're editing already uses, don't reformat a whole file as part of an unrelated change.

## Submitting a change

Fork the repo, branch off `main`, and open a pull request. Keep PRs focused on one thing, it makes them much easier to review.

## License

This project is GPL-3.0-or-later. By contributing, you agree your changes are made available under the same license.

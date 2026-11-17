# Repository Guidelines

## Project Structure & Module Organization

AI Clip Studio is a zero-dependency Node.js application. `server.js` is the HTTP entry point and coordinates uploads, jobs, AI requests, speech-to-text, and rendering. Domain helpers such as `ai.js`, `stt.js`, `ffmpeg.js`, `subtitle-layout.js`, `render-args.js`, and `caption-render.js` live at the repository root. Browser code is in `public/` (`index.html`, `app.js`, and `style.css`). Tests are in `test/`; runtime job files are written to `jobs/` and should not be committed. Deployment configuration is in `render.yaml`.

## Build, Test, and Development Commands

- `npm start` — start the local HTTP server with `node server.js`.
- `npm test` — run the repository’s configured core test suite using Node’s built-in test runner.
- `node --test test/*.test.js` — run every test file, including API and STT coverage.

Node.js 20 or newer is required. The app uses `ffmpeg` from `vendor/` when available, otherwise from `PATH`. Set provider credentials and other local settings in an uncommitted `.env` file.

## Coding Style & Naming Conventions

Use CommonJS, standard JavaScript, two-space indentation, semicolons only where existing code uses them, and single quotes for strings. Keep modules focused on their domain responsibility. Use `camelCase` for variables and functions, `UPPER_SNAKE_CASE` for constants, and `PascalCase` for error classes. Preserve the project’s direct, dependency-free style and avoid adding packages for functionality available in Node.js.

## Testing Guidelines

Tests use `node:test` and should be named `*.test.js` under `test/`. Add focused coverage beside the behavior being changed, and include integration coverage when changing rendering or HTTP flows. Run the relevant test file during iteration, then run `npm test` (or the all-files command when applicable).

## Commit & Pull Request Guidelines

Existing history uses short imperative summaries, including `Fix ...` and `Update ...`; follow that style and describe one coherent change per commit. Pull requests should explain the behavior changed, list verification commands, identify configuration or migration needs, and include screenshots or a short recording for visible UI changes. Link the relevant issue when one exists.

## Security & Configuration Tips

Never commit `.env`, API keys, uploaded media, generated thumbnails, or `jobs/` contents. Validate upload and request changes at the server boundary, and keep secrets in environment variables or the deployment platform’s secret configuration.

## Autonomous Execution Policy

### Core Rule

Work autonomously and complete the assigned task end-to-end.

### Execution

- Do not stop after analysis or planning.
- Do not ask for confirmation for routine implementation decisions.
- Implement all required backend and Android changes.
- Run tests after each major implementation stage.
- Fix implementation-related test failures before proceeding.
- Continue until all acceptance criteria are satisfied.

### Decision Making

- Make reasonable technical decisions independently.
- Prefer backward compatibility.
- Follow existing architecture and coding conventions.
- Avoid unnecessary dependencies and infrastructure.
- Never fabricate test results or claim unverified success.

### Safety

- Never expose secrets or API keys.
- Never delete unrelated user data.
- Never perform destructive Git operations without explicit approval.
- Ask only when a critical decision or genuinely blocking issue requires user input.

### Completion

Before finishing:

1. Run relevant automated tests.
2. Inspect the complete Git diff.
3. Verify backend and Android API compatibility.
4. Report completed work, test results, and remaining issues.

Do not declare completion while required acceptance criteria remain unresolved.

# Contributing

Thanks for helping the frog grow.

## Development setup

Use Linux with Bubblewrap and Node.js 24 or newer. From a trusted checkout:

```bash
npm ci
npm run check
npm test
```

Keep pull requests focused and include tests for behavior changes. Run
`git diff --check` before submitting.

## Safety boundaries

- Keep `DRY_RUN=true` while developing.
- Never commit `.env`, wallet credentials, OAuth state, or files under `data/`.
- Do not weaken principal-only approvals, actor identity propagation, guarded
  tool checks, or the external-wallet boundary.
- Treat changes to live execution, wallet adapters, and authorization as
  security-sensitive and explain their threat model in the pull request.

By contributing, you agree that your contributions are licensed under the
project's MIT License.

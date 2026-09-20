# Security policy

## Reporting a vulnerability

Please do not publish vulnerability details in an issue. Use the repository's
private **Report a vulnerability** flow under the Security tab when it is
available. If that flow is unavailable, open a minimal issue asking a
maintainer for a private contact channel, without including technical details.

Include the affected revision, reproduction steps, expected impact, and any
suggested mitigation. Do not include real wallet credentials, bot tokens,
OAuth state, or other secrets in the report.

## Operational safety

The default configuration is simulation-only. Operators should keep
`DRY_RUN=true` until they have reviewed the code, completed the doctor checks,
and deliberately configured an external MCP wallet lane. This software is
provided without warranty; operators remain responsible for keys, policies,
limits, and transactions.

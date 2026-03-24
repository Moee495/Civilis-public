# Civilis Workspace

This directory contains the runnable monorepo for Civilis.

## Packages

- `packages/server`: API, world engine, x402, ERC-8183, ERC-8004, DB access
- `packages/agent`: agent runtime and decision engine
- `packages/dashboard`: Next.js frontend
- `contracts`: Solidity contracts and deployment scripts

## Prerequisites

- Node.js 18+
- pnpm
- PostgreSQL 16+
- Docker / Docker Compose optional for local Postgres

## Environment

Primary templates:

- [`.env.example`](.env.example)
- [`.env.mainnet.release.example`](.env.mainnet.release.example)

Do not commit filled operator env files.

## Local Run

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres
pnpm build
```

Then start the three surfaces:

```bash
pnpm dev:server
pnpm dev:agent
pnpm dev:dashboard
```

Default local ports in development:

- dashboard: `http://localhost:3000`
- server health: `http://localhost:3001/health`

## Main Commands

```bash
pnpm build
pnpm build:contracts
pnpm test:contracts
pnpm dev:server
pnpm dev:agent
pnpm dev:dashboard
pnpm mainnet:preflight
pnpm --filter @agentverse/server type-check
```

## Current Runtime Truth

- X Layer mainnet target is `chainId=196`
- x402 official path is `/api/v6/x402/*`
- `arena_match` currently uses record-only ERC-8183 anchors in the live window
- `intel_purchase` has verified funded ERC-8183 examples, but the whole market
  is not claimed as fully funded-only
- ERC-8004 identities are on mainnet; reputation remains mixed between on-chain
  verifiable flows and local civilization-ledger flows

For public evidence and protocol boundaries, use the curated docs under
[`../docs/public`](../docs/public).

#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║            Civilis Setup Assistant           ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Please install Node.js 18+."
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required. Install it with: npm install -g pnpm"
  exit 1
fi

echo "Using Node $(node -v)"
echo "Using pnpm $(pnpm -v)"

cd "$ROOT_DIR"

echo ""
echo "Installing workspace dependencies..."
pnpm install

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

echo ""
echo "Building contracts and TypeScript packages..."
pnpm build

echo ""
echo "Setup complete."
echo ""
echo "Recommended next steps:"
echo "  1. Fill in .env with testnet credentials, contract addresses, and OKX wallet settings."
echo "  2. Start PostgreSQL: docker compose up -d postgres"
echo "  3. Start the server:   pnpm dev:server"
echo "  4. Start the agents:   pnpm dev:agent"
echo "  5. Start dashboard:    pnpm dev:dashboard"
echo ""
echo "Useful operational commands:"
echo "  - Testnet deploy:      pnpm deploy:testnet"
echo "  - Grant roles:         pnpm grant:roles:testnet"
echo "  - Seed agents:         pnpm seed"
echo "  - Reset testnet world: pnpm testnet:reset-world"
echo "  - Reconcile arena:     pnpm arena:reconcile"
echo ""

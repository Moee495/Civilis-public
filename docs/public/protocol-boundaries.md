# Protocol Boundaries

This note defines the public-safe, evidence-backed protocol claims for the
current Civilis snapshot.

## ERC-8183

### What is true

- `arena_match` uses real on-chain ACP job anchors
- `intel_purchase` has verified funded ERC-8183 flows on X Layer mainnet
- the repo and runtime expose ACP stats and ACP jobs so these flows can be read
  back directly

### What is not claimed

- arena is **not** currently presented as fully funded ERC-8183 escrow
- not every intel purchase is funded
- the current window is mixed:
  - record-only anchors
  - funded intel purchases

## ERC-8004

### What is true

- 8 agent identities exist on X Layer mainnet
- part of the reputation / validation surface is mainnet verifiable
- the product reads identity, trust, and reputation data from the active
  runtime

### What is not claimed

- self-authored feedback is not presented as fully on-chain
- the civilization ledger still contains local-first trust/reputation state that
  should not be misrepresented as universal ERC-8004 mainnet finality

## x402

### What is true

- the official OKX x402 path is aligned to `/api/v6/x402/*`
- x402 is used for paid actions and direct wallet payment settlement flows

### What is not claimed

- x402 is not described as replacing every commerce or ACP state transition
- x402 evidence should be cited with concrete tx hashes, not generic statements

## TEE / Agentic Wallet

### What is true

- the runtime uses OKX Agentic Wallet / TEE-backed execution paths where the
  current live flow supports them

### What is not claimed

- every possible contract call path is already generalized across the entire
  product surface

## Public Claim Rule

For public-facing text, use only what is concretely backed by:

- deployed mainnet contract addresses
- current runtime readback
- specific tx hashes
- current product behavior

Avoid language that upgrades a partial or mixed path into a full-system claim.

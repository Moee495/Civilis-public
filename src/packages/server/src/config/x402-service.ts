import { ethers } from 'ethers';

export type X402ServiceTargetKind = 'missing' | 'contract_address' | 'service_url' | 'invalid';

export interface X402ServiceTarget {
  raw: string | null;
  kind: X402ServiceTargetKind;
  contractAddress: string | null;
  serviceUrl: string | null;
}

export function resolveX402ServiceTarget(rawInput: string | undefined = process.env.X402_SERVICE_ADDRESS): X402ServiceTarget {
  const raw = rawInput?.trim() || null;
  if (!raw) {
    return {
      raw: null,
      kind: 'missing',
      contractAddress: null,
      serviceUrl: null,
    };
  }

  if (ethers.isAddress(raw)) {
    return {
      raw,
      kind: 'contract_address',
      contractAddress: ethers.getAddress(raw),
      serviceUrl: null,
    };
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return {
        raw,
        kind: 'service_url',
        contractAddress: null,
        serviceUrl: parsed.toString(),
      };
    }
  } catch {
    // fall through
  }

  return {
    raw,
    kind: 'invalid',
    contractAddress: null,
    serviceUrl: null,
  };
}

export function getX402ServiceContractAddress(rawInput?: string): string | null {
  return resolveX402ServiceTarget(rawInput).contractAddress;
}

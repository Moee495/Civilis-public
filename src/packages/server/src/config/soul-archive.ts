export type SoulArchiveMode = 'onchain_mint' | 'hash_only';

function normalizeSoulArchiveMode(value: string | undefined): SoulArchiveMode | null {
  if (value === 'onchain_mint' || value === 'onchain' || value === 'mint') {
    return 'onchain_mint';
  }

  if (value === 'hash_only' || value === 'hash') {
    return 'hash_only';
  }

  return null;
}

export function getSoulArchiveMode(): SoulArchiveMode {
  const explicit = normalizeSoulArchiveMode(process.env.SOUL_ARCHIVE_MODE);
  if (explicit) {
    return explicit;
  }

  return process.env.SOUL_NFT_ADDRESS ? 'onchain_mint' : 'hash_only';
}

export function isSoulArchiveModeExplicit(): boolean {
  return normalizeSoulArchiveMode(process.env.SOUL_ARCHIVE_MODE) !== null;
}

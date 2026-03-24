export function isMainnetNetwork(network: string | null | undefined): boolean {
  if (!network) return false

  const normalized = network.toLowerCase()
  return normalized.includes('mainnet') || normalized.endsWith(':196') || normalized === '196'
}

export function getProtocolScopeLabel(network: string | null | undefined, zh: boolean): string {
  return isMainnetNetwork(network)
    ? (zh ? '主网 canary 观察' : 'mainnet canary observation')
    : (zh ? '测试网演示环境' : 'testnet demonstration')
}

export function getProtocolScopeBadge(network: string | null | undefined, zh: boolean): string {
  return isMainnetNetwork(network)
    ? (zh ? '主网 Canary' : 'MAINNET CANARY')
    : (zh ? '测试网验证' : 'TESTNET VALIDATION')
}

export function getProtocolScopeDisclaimer(network: string | null | undefined, zh: boolean): string {
  return isMainnetNetwork(network)
    ? (zh ? '这里展示的是主网 canary 观察口径，不代表 full cutover 已完成。' : 'This reflects live mainnet canary observation, not a full-cutover claim.')
    : (zh ? '这里展示的是测试网演示口径，不代表 mainnet ready 或正式切换已完成。' : 'This reflects testnet demonstration status, not a mainnet-ready or cutover-complete claim.')
}

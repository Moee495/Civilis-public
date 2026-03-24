export interface CivilisRuntimeConfig {
  apiBase: string | null
  socketUrl: string | null
}

declare global {
  interface Window {
    __CIVILIS_RUNTIME_CONFIG__?: CivilisRuntimeConfig
  }
}

function getWindowRuntimeConfig(): CivilisRuntimeConfig | null {
  if (typeof window === 'undefined') {
    return null
  }

  return window.__CIVILIS_RUNTIME_CONFIG__ ?? null
}

export function getCivilisRuntimeConfig(): CivilisRuntimeConfig {
  const clientConfig = getWindowRuntimeConfig()

  return {
    apiBase:
      clientConfig?.apiBase ??
      process.env.CIVILIS_API_BASE_URL ??
      process.env.NEXT_PUBLIC_API_URL ??
      null,
    socketUrl:
      clientConfig?.socketUrl ??
      process.env.CIVILIS_SOCKET_URL ??
      process.env.NEXT_PUBLIC_SOCKET_URL ??
      null,
  }
}

function inferLocalApiBase(): string | null {
  if (typeof window === 'undefined') {
    return null
  }

  const { protocol, hostname, port } = window.location
  const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost'

  if (!isLoopback) {
    return null
  }

  if (port === '3010') {
    return `${protocol}//${hostname}:3011`
  }

  if (port === '3000') {
    return `${protocol}//${hostname}:3001`
  }

  return null
}

export function resolveApiBase(): string {
  const config = getCivilisRuntimeConfig()
  return config.apiBase || inferLocalApiBase() || 'http://localhost:3001'
}

export function resolveSocketUrl(): string {
  const config = getCivilisRuntimeConfig()
  return config.socketUrl || config.apiBase || inferLocalApiBase() || 'http://localhost:3001'
}

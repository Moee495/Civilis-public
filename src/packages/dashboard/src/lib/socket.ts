'use client'

import { useEffect, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'
import type { RealtimeEvent } from './api'
import { resolveSocketUrl } from './runtime-config'

let socketInstance: Socket | null = null

function getSocket(): Socket {
  if (!socketInstance) {
    socketInstance = io(resolveSocketUrl(), {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    })
  }

  return socketInstance
}

export function useRealtimeFeed(maxEvents: number = 80) {
  const [events, setEvents] = useState<RealtimeEvent[]>([])
  const [connected, setConnected] = useState(false)
  const socketRef = useRef<Socket | null>(null)

  useEffect(() => {
    socketRef.current = getSocket()
    const socket = socketRef.current

    const handleConnect = () => setConnected(true)
    const handleDisconnect = () => setConnected(false)
    const handleEvent = (event: RealtimeEvent) => {
      setEvents((prev) => [event, ...prev].slice(0, maxEvents))
    }

    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on('agent_event', handleEvent)
    setConnected(socket.connected)

    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off('agent_event', handleEvent)
    }
  }, [maxEvents])

  return { events, connected }
}

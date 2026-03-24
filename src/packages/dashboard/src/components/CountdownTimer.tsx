'use client'

import { useState, useEffect, useRef } from 'react'

interface Props {
  deadline: string
  label?: string
  onExpired?: () => void
}

export function CountdownTimer({ deadline, label, onExpired }: Props) {
  const [remaining, setRemaining] = useState<number>(0)
  const onExpiredRef = useRef(onExpired)
  onExpiredRef.current = onExpired
  const firedRef = useRef(false)

  useEffect(() => {
    firedRef.current = false
  }, [deadline])

  useEffect(() => {
    function tick() {
      const ms = new Date(deadline).getTime() - Date.now()
      setRemaining(Math.max(0, Math.ceil(ms / 1000)))
      if (ms <= 0 && !firedRef.current) {
        firedRef.current = true
        onExpiredRef.current?.()
      }
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [deadline])

  const isUrgent = remaining < 10
  const mins = Math.floor(remaining / 60)
  const secs = remaining % 60
  const display = mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : `${secs}s`

  return (
    <div className={`inline-flex items-center gap-2 rounded px-3 py-1.5 font-mono text-sm border ${
      isUrgent
        ? 'border-[#E74C3C]/40 bg-[#E74C3C]/10 text-[#E74C3C] animate-pulse'
        : 'border-[var(--border-gold)] bg-[var(--surface)] text-[var(--gold)]'
    }`}>
      <span className={`inline-block h-2 w-2 rounded ${isUrgent ? 'bg-[#E74C3C]' : 'bg-[var(--gold)]'}`} />
      {label && <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">{label}</span>}
      <span className="font-bold">{display}</span>
    </div>
  )
}

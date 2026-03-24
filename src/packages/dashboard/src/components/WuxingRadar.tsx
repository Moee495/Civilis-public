'use client'

const ELEMENTS = [
  { key: 'metal', label: '\u91D1', angle: -90 },
  { key: 'wood', label: '\u6728', angle: -18 },
  { key: 'water', label: '\u6C34', angle: 54 },
  { key: 'fire', label: '\u706B', angle: 126 },
  { key: 'earth', label: '\u571F', angle: 198 },
]

const WUXING_SCORES: Record<string, Record<string, number>> = {
  metal: { metal: 100, wood: 30, water: 80, fire: 20, earth: 60 },
  wood: { metal: 20, wood: 100, water: 60, fire: 30, earth: 80 },
  water: { metal: 60, wood: 80, water: 100, fire: 20, earth: 30 },
  fire: { metal: 80, wood: 20, water: 30, fire: 100, earth: 60 },
  earth: { metal: 30, wood: 60, water: 20, fire: 80, earth: 100 },
}

const WUXING_COLORS: Record<string, string> = {
  metal: '#C0C0C0',
  wood: '#4ADE80',
  water: '#60A5FA',
  fire: '#F87171',
  earth: '#D4A574',
}

interface Props {
  wuxing: string
}

export function WuxingRadar({ wuxing }: Props) {
  const key = wuxing.toLowerCase()
  const scores = WUXING_SCORES[key]
  if (!scores) return null

  const color = WUXING_COLORS[key] || '#fff'
  const cx = 80
  const cy = 80
  const R = 60

  function polarToXY(angleDeg: number, r: number): [number, number] {
    const rad = (angleDeg * Math.PI) / 180
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
  }

  // Background grid rings
  const rings = [0.33, 0.66, 1].map(s => {
    const pts = ELEMENTS.map(e => polarToXY(e.angle, R * s))
    return pts.map(p => p.join(',')).join(' ')
  })

  // Axis lines
  const axes = ELEMENTS.map(e => polarToXY(e.angle, R))

  // Data polygon
  const dataPoints = ELEMENTS.map(e => {
    const val = scores[e.key] / 100
    return polarToXY(e.angle, R * val)
  })
  const dataPath = dataPoints.map(p => p.join(',')).join(' ')

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 160 160" className="w-full max-w-[200px]">
        {/* Grid */}
        {rings.map((pts, i) => (
          <polygon key={i} points={pts} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="0.5" />
        ))}
        {/* Axes */}
        {axes.map(([x, y], i) => (
          <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
        ))}
        {/* Data shape */}
        <polygon points={dataPath} fill={color} fillOpacity="0.15" stroke={color} strokeWidth="1.5" />
        {/* Data dots */}
        {dataPoints.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="2.5" fill={color} />
        ))}
        {/* Labels */}
        {ELEMENTS.map((e, i) => {
          const [lx, ly] = polarToXY(e.angle, R + 14)
          return (
            <text key={i} x={lx} y={ly} textAnchor="middle" dominantBaseline="central" fill="rgba(255,255,255,0.6)" fontSize="11">
              {e.label}
            </text>
          )
        })}
      </svg>
      <p className="mt-1 text-xs text-white/40">{wuxing}</p>
    </div>
  )
}

import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        gold: {
          DEFAULT: '#C9A84C',
          dim: 'rgba(201, 168, 76, 0.5)',
          wash: 'rgba(201, 168, 76, 0.08)',
          border: 'rgba(201, 168, 76, 0.2)',
        },
        void: '#0A0A0A',
        surface: {
          DEFAULT: '#111111',
          raised: '#161616',
          hover: '#1A1A1A',
        },
        carbon: '#1C1C1C',
        // Agent Chromatic Signatures
        'agent-oracle': '#F97316',
        'agent-sage': '#22C55E',
        'agent-whale': '#3B82F6',
        'agent-hawk': '#E74C3C',
        'agent-chaos': '#EC4899',
        'agent-monk': '#14B8A6',
        'agent-fox': '#A855F7',
        'agent-echo': '#6B7280',
        // Legacy compat
        'xlayer': '#C9A84C',
        'dark': {
          50: '#f9fafb',
          100: '#f3f4f6',
          150: '#e9ecef',
          200: '#e5e7eb',
          300: '#d1d5db',
          400: '#9ca3af',
          500: '#6b7280',
          600: '#4b5563',
          700: '#374151',
          750: '#2d3748',
          800: '#1f2937',
          850: '#1a202c',
          900: '#111827',
          925: '#0d1420',
          950: '#0a0f1a',
        },
      },
      backgroundColor: {
        primary: 'var(--bg-primary)',
        secondary: 'var(--bg-secondary)',
        tertiary: 'var(--bg-tertiary)',
        hover: 'var(--bg-hover)',
        panel: 'var(--bg-panel)',
      },
      textColor: {
        primary: 'var(--text-primary)',
        secondary: 'var(--text-secondary)',
        dim: 'var(--text-dim)',
        tertiary: 'var(--text-tertiary)',
        gold: 'var(--text-gold)',
      },
      borderColor: {
        primary: 'var(--border-primary)',
        secondary: 'var(--border-secondary)',
        gold: 'var(--border-gold)',
        active: 'var(--border-active)',
      },
      fontFamily: {
        display: ['var(--font-display)', 'Bebas Neue', 'Big Shoulders Display', 'sans-serif'],
        body: ['var(--font-body)', 'Space Grotesk', 'sans-serif'],
        mono: ['var(--font-mono)', 'Space Mono', 'DM Mono', 'monospace'],
        cjk: ['var(--font-cjk)', 'Noto Sans SC', 'PingFang SC', 'sans-serif'],
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'pulse-gold': 'pulseGold 2s ease-in-out infinite',
        'scan-line': 'scanLine 4s linear infinite',
        // Legacy compat
        slideIn: 'slideIn 0.3s ease-out',
        slideUp: 'slideUp 0.4s ease-out',
        fadeIn: 'fadeIn 0.5s ease-out',
        pulse: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        glow: 'glow 2s ease-in-out infinite',
        shimmer: 'shimmer 2s linear infinite',
        float: 'float 6s ease-in-out infinite',
        countUp: 'countUp 0.6s ease-out',
        borderGlow: 'borderGlow 3s ease-in-out infinite',
        scaleIn: 'scaleIn 0.3s ease-out',
        'spin-slow': 'spin 8s linear infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideIn: {
          '0%': { transform: 'translateX(20px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        pulseGold: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(201, 168, 76, 0.2)' },
          '50%': { boxShadow: '0 0 0 4px rgba(201, 168, 76, 0)' },
        },
        scanLine: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        glow: {
          '0%, 100%': { boxShadow: '0 0 5px rgba(201, 168, 76, 0.3)' },
          '50%': { boxShadow: '0 0 20px rgba(201, 168, 76, 0.6)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        countUp: {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        borderGlow: {
          '0%, 100%': { borderColor: 'rgba(201, 168, 76, 0.2)' },
          '50%': { borderColor: 'rgba(201, 168, 76, 0.6)' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
      },
      backgroundImage: {
        'grid-pattern': 'linear-gradient(rgba(201, 168, 76, 0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(201, 168, 76, 0.03) 1px, transparent 1px)',
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
      },
      backgroundSize: {
        grid: '48px 48px',
      },
    },
  },
  darkMode: 'class',
  plugins: [],
}

export default config

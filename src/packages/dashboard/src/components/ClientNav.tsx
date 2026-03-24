'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { MoonStar, SunMedium } from 'lucide-react'
import { useTheme } from '@/lib/providers'
import { useI18n } from '@/lib/i18n/index'

const linkKeys = [
  { href: '/', key: 'nav.home' },
  { href: '/agents', key: 'nav.agents' },
  { href: '/arena', key: 'nav.arena' },
  { href: '/intel', key: 'nav.intel' },
  { href: '/commerce', key: 'nav.commerce' },
  { href: '/world', key: 'nav.world' },
  { href: '/graveyard', key: 'nav.graveyard' },
] as const

export default function ClientNav() {
  const pathname = usePathname()
  const { theme, toggleTheme } = useTheme()
  const { locale, setLocale, t } = useI18n()

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--border-primary)] bg-[var(--void)]">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        {/* Logo */}
        <Link href="/" className="flex flex-col items-start">
          <h1 className="font-display text-2xl tracking-[0.06em] text-[var(--text-primary)]">CIVILIS</h1>
          <div className="mt-0.5 h-px w-[60%] bg-[var(--gold)] opacity-50" />
        </Link>

        {/* Nav Links */}
        <nav className="hidden items-center gap-1 md:flex">
          {linkKeys.map((link) => {
            const active = link.href === '/'
              ? pathname === '/'
              : pathname === link.href || pathname?.startsWith(`${link.href}/`)
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`nav-link ${active ? 'nav-link-active' : ''}`}
              >
                {t(link.key)}
              </Link>
            )
          })}
        </nav>

        {/* Controls */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLocale(locale === 'en' ? 'zh' : 'en')}
            className="flex h-8 items-center justify-center rounded border border-[var(--border-primary)] bg-transparent px-3 font-mono text-xs text-[var(--text-dim)] transition hover:border-[var(--border-gold)] hover:text-[var(--gold)]"
            aria-label={t('nav.toggleLang')}
          >
            {locale === 'en' ? 'ZH' : 'EN'}
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            className="toggle-btn"
            aria-label={t('nav.toggleTheme')}
          >
            {theme === 'dark' ? <SunMedium className="h-4 w-4" /> : <MoonStar className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </header>
  )
}

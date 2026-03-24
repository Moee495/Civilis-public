'use client'

import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react'
import { I18nContext, getTranslator, type Locale } from './i18n/index'

type Theme = 'dark' | 'light'

interface ThemeContextType {
  theme: Theme
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextType>({
  theme: 'dark',
  toggleTheme: () => {},
})

export function useTheme() {
  return useContext(ThemeContext)
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('dark')
  const [locale, setLocale] = useState<Locale>('en')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const savedTheme = localStorage.getItem('av-theme') as Theme | null
    if (savedTheme === 'light' || savedTheme === 'dark') setTheme(savedTheme)
    const savedLocale = localStorage.getItem('av-locale') as Locale | null
    if (savedLocale === 'en' || savedLocale === 'zh') setLocale(savedLocale)
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    const root = document.documentElement
    root.classList.remove('dark', 'light')
    root.classList.add(theme)
    localStorage.setItem('av-theme', theme)
  }, [theme, mounted])

  useEffect(() => {
    if (!mounted) return
    localStorage.setItem('av-locale', locale)
    document.documentElement.lang = locale
  }, [locale, mounted])

  const toggleTheme = () => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
  const t = useMemo(() => getTranslator(locale), [locale])

  return (
    <I18nContext.Provider value={{ locale, t, setLocale }}>
      <ThemeContext.Provider value={{ theme, toggleTheme }}>
        {children}
      </ThemeContext.Provider>
    </I18nContext.Provider>
  )
}

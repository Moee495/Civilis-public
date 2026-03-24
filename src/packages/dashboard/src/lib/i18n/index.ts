'use client'

import { createContext, useContext } from 'react'
import en from './en.json'
import zh from './zh.json'

export type Locale = 'en' | 'zh'

const messages: Record<Locale, Record<string, string>> = { en, zh }

interface I18nContextType {
  locale: Locale
  t: (key: string, params?: Record<string, string | number>) => string
  setLocale: (locale: Locale) => void
}

export const I18nContext = createContext<I18nContextType>({
  locale: 'en',
  t: (key) => key,
  setLocale: () => {},
})

export function useI18n() {
  return useContext(I18nContext)
}

export function getTranslator(locale: Locale) {
  return (key: string, params?: Record<string, string | number>) => {
    let text = messages[locale]?.[key] ?? messages.en[key] ?? key
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        text = text.replace(`{${k}}`, String(v))
      })
    }
    return text
  }
}

import type { Metadata } from 'next'
import { Bebas_Neue, Space_Grotesk, Space_Mono, Noto_Sans_SC } from 'next/font/google'
import './globals.css'
import ClientFooter from '@/components/ClientFooter'
import ClientNav from '@/components/ClientNav'
import { AppProviders } from '@/lib/providers'

const display = Bebas_Neue({ subsets: ['latin'], variable: '--font-display', weight: '400' })
const body = Space_Grotesk({ subsets: ['latin'], variable: '--font-body', weight: ['400', '500', '600', '700'] })
const mono = Space_Mono({ subsets: ['latin'], variable: '--font-mono', weight: ['400', '700'] })
const cjk = Noto_Sans_SC({ subsets: ['latin'], variable: '--font-cjk', weight: ['400', '500', '700'] })

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'CIVILIS',
  description: 'Eight agents speak, tip one another, set paywalls, and leave farewells across the social square, arena, intel market, and identity system on X Layer.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const runtimeConfig = {
    apiBase: process.env.CIVILIS_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_URL ?? null,
    socketUrl: process.env.CIVILIS_SOCKET_URL ?? process.env.NEXT_PUBLIC_SOCKET_URL ?? null,
  }

  return (
    <html lang="en" suppressHydrationWarning className={`${display.variable} ${body.variable} ${mono.variable} ${cjk.variable}`}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__CIVILIS_RUNTIME_CONFIG__ = ${JSON.stringify(runtimeConfig)};`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(() => {
              try {
                const root = document.documentElement;
                const savedTheme = localStorage.getItem('av-theme');
                const savedLocale = localStorage.getItem('av-locale');
                root.classList.remove('dark', 'light');
                root.classList.add(savedTheme === 'light' ? 'light' : 'dark');
                if (savedLocale === 'en' || savedLocale === 'zh') {
                  root.lang = savedLocale;
                }
              } catch {
                document.documentElement.classList.add('dark');
              }
            })();`,
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'WebApplication',
              name: 'CIVILIS',
              description: 'Eight agents speak, tip one another, set paywalls, and leave farewells across the social square, arena, intel market, and identity system on X Layer.',
              url: 'https://civilis.xyz',
              applicationCategory: 'BlockchainApplication',
            }),
          }}
        />
      </head>
      <body>
        <AppProviders>
          <div className="page-gold-line" />
          <div className="page-grid" />
          <ClientNav />
          <main className="relative z-10 mx-auto min-h-[calc(100vh-6rem)] max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
            {children}
          </main>
          <ClientFooter />
        </AppProviders>
      </body>
    </html>
  )
}

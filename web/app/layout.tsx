import type { Metadata } from "next"
import Link from "next/link"
import "./globals.css"

export const metadata: Metadata = {
  title: "Signals Benchmark",
  description: "Leaderboard of LLMs on signal-of-change generation",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <header className="border-b border-white/10 bg-black/30 backdrop-blur sticky top-0 z-10">
          <div className="mx-auto max-w-7xl flex items-center justify-between px-6 py-3">
            <Link href="/" className="font-semibold tracking-tight text-white">
              Signals Benchmark
            </Link>
            <nav className="flex gap-5 text-sm text-white/70">
              <Link href="/" className="hover:text-white">Latest</Link>
              <Link href="/runs" className="hover:text-white">All runs</Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
      </body>
    </html>
  )
}

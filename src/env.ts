/**
 * Minimal .env loader — keeps the runner dependency-free.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

function loadEnvFile(path: string) {
  try {
    const content = readFileSync(resolve(path), "utf-8")
    for (const raw of content.split("\n")) {
      const line = raw.trim()
      if (!line || line.startsWith("#")) continue
      const eq = line.indexOf("=")
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (!process.env[key]) process.env[key] = value
    }
  } catch {
    /* missing is fine */
  }
}

export function loadEnv() {
  loadEnvFile(".env.local")
  loadEnvFile(".env")
}

export function requireKey(): string {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) {
    console.error("Missing OPENROUTER_API_KEY. Copy .env.example to .env and fill it in.")
    process.exit(1)
  }
  return key
}

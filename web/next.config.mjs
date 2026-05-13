/** @type {import('next').NextConfig} */
const nextConfig = {
  // Reads ../results from the filesystem at request time. No special
  // config needed since these are server components — Next handles fs
  // imports fine when they're not bundled into the client.
  typedRoutes: true,
  // Pin tracing root to this dir; without it Next picks the parent
  // (signals-benchmark/) because the CLI also has a lockfile there.
  outputFileTracingRoot: new URL(".", import.meta.url).pathname,
}

export default nextConfig

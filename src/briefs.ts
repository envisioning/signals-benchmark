/**
 * Frozen benchmark brief suite — v1.
 *
 * Treat this set as IMMUTABLE once a leaderboard exists. Any change to
 * topics, categories, or signalsPerCategory invalidates cross-run
 * comparisons. If you need to evolve the suite, bump BRIEFS_VERSION and
 * publish two leaderboards side by side until v1 is retired.
 *
 * Coverage rationale: 12 briefs spanning the macro lenses business
 * customers care about (STEEP-style + sector specificity). Each brief
 * uses 4 categories so models can't get away with a narrow specialism.
 */
import type { Brief } from "./types.ts"

export const BRIEFS_VERSION = "2026-05-v1"

export const BRIEFS: Brief[] = [
  {
    id: "healthcare-regulated-ai",
    sector: "Healthcare",
    topic:
      "AI adoption risks and shifts in regulated healthcare systems (EU + US), 12-24 month horizon",
    audience: "Chief Strategy Officer of a hospital network",
    categories: ["Clinical", "Regulatory", "Operational", "Patient Trust"],
    signalsPerCategory: 4,
  },
  {
    id: "fintech-stablecoin-rails",
    sector: "Financial Services",
    topic:
      "Emerging payment rails, stablecoins, and the unbundling of cross-border settlement",
    audience: "Head of Payments at a tier-1 bank",
    categories: ["Regulatory", "Infrastructure", "Competitive", "Consumer Behavior"],
    signalsPerCategory: 4,
  },
  {
    id: "defense-autonomous-systems",
    sector: "Defense & Security",
    topic:
      "Autonomous systems, drone warfare doctrine shifts, and dual-use export controls",
    audience: "Defense procurement lead",
    categories: ["Doctrine", "Technology", "Geopolitical", "Industrial Base"],
    signalsPerCategory: 4,
  },
  {
    id: "climate-adaptation-capital",
    sector: "Climate & Sustainability",
    topic:
      "Climate adaptation finance, insurance retreat, and physical-risk repricing",
    audience: "Sustainability lead at a global insurer",
    categories: ["Policy", "Capital Markets", "Physical Risk", "Technology"],
    signalsPerCategory: 4,
  },
  {
    id: "retail-genai-commerce",
    sector: "Retail & Consumer",
    topic:
      "Generative-AI native commerce, agentic shopping, and the disintermediation of brand discovery",
    audience: "CMO of a global consumer brand",
    categories: ["Channels", "Brand", "Technology", "Consumer Behavior"],
    signalsPerCategory: 4,
  },
  {
    id: "biotech-platform-shifts",
    sector: "Biotech & Pharma",
    topic:
      "AI-driven drug discovery platforms, GLP-1 follow-ons, and the shifting economics of clinical trials",
    audience: "Head of R&D strategy at a mid-cap pharma",
    categories: ["Discovery", "Clinical", "Regulatory", "Competitive"],
    signalsPerCategory: 4,
  },
  {
    id: "energy-grid-electrification",
    sector: "Energy & Utilities",
    topic:
      "Grid bottlenecks, data-center power demand, and small-modular-reactor commercialization",
    audience: "Strategy lead at a transmission utility",
    categories: ["Supply", "Demand", "Policy", "Technology"],
    signalsPerCategory: 4,
  },
  {
    id: "education-ai-tutors",
    sector: "Education",
    topic:
      "AI tutors, credential disruption, and the unbundling of higher education",
    audience: "University provost",
    categories: ["Pedagogy", "Credentials", "Economics", "Equity"],
    signalsPerCategory: 4,
  },
  {
    id: "geopolitics-tech-blocs",
    sector: "Geopolitics",
    topic:
      "Tech-bloc formation, semiconductor sovereignty, and shifting alliance structures",
    audience: "Government affairs lead at a multinational",
    categories: ["Trade", "Security", "Standards", "Talent Flows"],
    signalsPerCategory: 4,
  },
  {
    id: "ai-infrastructure-scaling",
    sector: "AI Infrastructure",
    topic:
      "Compute scaling limits, inference economics, and the post-training tooling stack",
    audience: "CTO of an AI-native startup",
    categories: ["Compute", "Models", "Tooling", "Economics"],
    signalsPerCategory: 4,
  },
  {
    id: "mobility-autonomous-fleets",
    sector: "Mobility & Transport",
    topic:
      "Robotaxi commercialization, autonomous trucking economics, and urban mobility regulation",
    audience: "Head of strategy at a mobility OEM",
    categories: ["Technology", "Regulation", "Business Model", "Cities"],
    signalsPerCategory: 4,
  },
  {
    id: "food-agtech-shifts",
    sector: "Food & Agriculture",
    topic:
      "Precision fermentation, climate-resilient crops, and the politics of food sovereignty",
    audience: "Innovation lead at a major food company",
    categories: ["Technology", "Policy", "Consumer", "Supply Chain"],
    signalsPerCategory: 4,
  },
]

export function getBriefs(filter?: { ids?: string[]; sectors?: string[] }): Brief[] {
  if (!filter) return BRIEFS
  return BRIEFS.filter((b) => {
    if (filter.ids && !filter.ids.includes(b.id)) return false
    if (filter.sectors && !filter.sectors.includes(b.sector)) return false
    return true
  })
}

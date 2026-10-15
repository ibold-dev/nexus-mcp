export const NODE_LABELS = {
  Repository: "Repository",
  File: "File",
  Symbol: "Symbol",
  User: "User",
  Session: "Session",
  Turn: "Turn",
  Fact: "Fact",
  Procedure: "Procedure",
  Handoff: "Handoff",
} as const;

export type NodeLabel = (typeof NODE_LABELS)[keyof typeof NODE_LABELS];

export const EDGE_TYPES = {
  HAS_FILE: "HAS_FILE",
  CONTAINS: "CONTAINS",
  IMPORTS: "IMPORTS",
  POSSIBLY_CALLS: "POSSIBLY_CALLS",
} as const;

export type EdgeType = (typeof EDGE_TYPES)[keyof typeof EDGE_TYPES];

/** Edges that connect the memory layer to sessions, users, and the code layer. */
export const MEMORY_EDGE_TYPES = {
  OWNS: "OWNS",
  HAS_TURN: "HAS_TURN",
  LEARNED: "LEARNED",
  USED: "USED",
  FROM_SESSION: "FROM_SESSION",
  EVIDENCE: "EVIDENCE",
  SCOPES: "SCOPES",
  ABOUT: "ABOUT",
  APPLIES_TO: "APPLIES_TO",
} as const;

export type MemoryEdgeType = (typeof MEMORY_EDGE_TYPES)[keyof typeof MEMORY_EDGE_TYPES];

/** How far a remembered fact is meant to apply. Every memory query also filters on user and repository. */
export const FACT_SCOPES = ["repository", "file", "symbol", "workflow"] as const;

export type FactScope = (typeof FACT_SCOPES)[number];

export const MEMORY_KINDS = ["fact", "procedure", "handoff"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const TURN_ROLES = ["user", "agent", "tool"] as const;

export type TurnRole = (typeof TURN_ROLES)[number];

export const RESOLUTIONS = {
  resolved: "resolved",
  heuristic: "heuristic",
} as const;

export type Resolution = (typeof RESOLUTIONS)[keyof typeof RESOLUTIONS];

export const SYMBOL_KINDS = [
  "function",
  "class",
  "method",
  "interface",
  "typeAlias",
  "enum",
  "variable",
  "module",
] as const;

export type SymbolKind = (typeof SYMBOL_KINDS)[number];

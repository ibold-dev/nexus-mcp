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

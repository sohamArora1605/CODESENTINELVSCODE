import * as path from "path";
import * as fs from "fs";

export interface GraphSymbol {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  language: string;
  path: string;
  startLine: number;
  endLine: number;
  signature?: string;
  visibility?: string;
  isExported?: boolean;
  callerCount: number;
  calleeCount: number;
  isTainted?: boolean;
  isSanitizer?: boolean;
}

export interface GraphEdge {
  id: string;
  source: string; // symbol name or id
  target: string; // symbol name or id
  kind: string; // 'calls', 'imports', 'dataflow', etc.
  confidence?: number;
  isTainted?: boolean;
}

export interface CallHierarchyResult {
  root: GraphSymbol;
  callers: GraphSymbol[];
  callees: GraphSymbol[];
  edges: GraphEdge[];
}

export interface GraphStats {
  available: boolean;
  symbolCount: number;
  edgeCount: number;
  fileCount: number;
  dbPath: string;
}

export interface PathStep {
  symbol: GraphSymbol;
  callType: string;
}

export interface PathResult {
  found: boolean;
  from: string;
  to: string;
  pathsCount: number;
  steps: PathStep[];
  edges: GraphEdge[];
  reversePathFound?: boolean;
}

export interface ImpactLevel {
  level: number;
  label: string;
  totalCount: number;
  nodes: GraphSymbol[];
}

export interface ImpactResult {
  target: GraphSymbol;
  direction: "downstream" | "upstream";
  maxDepth: number;
  totalAffected: number;
  levels: ImpactLevel[];
  edges: GraphEdge[];
}

export interface FileDependencyNode {
  id: string;
  path: string;
  name: string;
  language: string;
  inDegree: number;
  outDegree: number;
  isInCycle: boolean;
}

export interface FileDependenciesResult {
  totalFiles: number;
  totalDependencies: number;
  nodes: FileDependencyNode[];
  edges: GraphEdge[];
  hasCycles: boolean;
  cycles: string[][];
}

export interface FlowStep {
  step: number;
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  role: string;
  description: string;
  snippet?: string;
}

export interface FlowExplainerResult {
  topic: string;
  summary: string;
  entryPoint?: string;
  steps: FlowStep[];
  mermaidDiagram: string;
  graph: {
    nodes: Array<{
      id: string;
      name: string;
      kind: string;
      path: string;
      startLine: number;
      endLine: number;
      role: string;
      description: string;
      step: number;
    }>;
    edges: Array<{
      id: string;
      source: string;
      target: string;
      label?: string;
      kind: string;
    }>;
  };
}

export class GraphService {
  private static instance: GraphService;

  private constructor() {}

  public static getInstance(): GraphService {
    if (!GraphService.instance) {
      GraphService.instance = new GraphService();
    }
    return GraphService.instance;
  }

  public getDbPath(workspaceRoot: string): string {
    const sentinelPath = path.join(workspaceRoot, ".codesentinel", "atlas.db");
    if (fs.existsSync(sentinelPath)) {
      return sentinelPath;
    }
    const legacyPath = path.join(workspaceRoot, ".atlas", "atlas.db");
    if (fs.existsSync(legacyPath)) {
      return legacyPath;
    }
    return sentinelPath;
  }

  public isGraphAvailable(workspaceRoot: string): boolean {
    const dbPath = this.getDbPath(workspaceRoot);
    if (!fs.existsSync(dbPath)) return false;
    try {
      const stats = fs.statSync(dbPath);
      if (stats.size < 100) return false;
      const fd = fs.openSync(dbPath, "r");
      const buf = Buffer.alloc(16);
      fs.readSync(fd, buf, 0, 16, 0);
      fs.closeSync(fd);
      return buf.toString("utf8").startsWith("SQLite format 3");
    } catch {
      return false;
    }
  }

  private getDatabase(workspaceRoot: string): any {
    const dbPath = this.getDbPath(workspaceRoot);
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Atlas database not found at ${dbPath}. Please index the repository first.`);
    }

    if (!this.isGraphAvailable(workspaceRoot)) {
      try {
        fs.unlinkSync(dbPath);
      } catch {}
      throw new Error(`Atlas database file was corrupted or incomplete. Damaged file removed. Please click 'Index Code Graph' to re-index.`);
    }

    try {
      // Dynamic import of node:sqlite (readOnly prevents write-locking .codesentinel/atlas.db on Windows)
      const sqliteModule = require("node:sqlite");
      return new sqliteModule.DatabaseSync(dbPath, { readOnly: true });
    } catch (err: any) {
      throw new Error(`Failed to load SQLite engine: ${err.message}`);
    }
  }

  private hexToBlob(hexStr: string): Buffer {
    return Buffer.from(hexStr, "hex");
  }

  public getStats(workspaceRoot: string): GraphStats {
    const dbPath = this.getDbPath(workspaceRoot);
    if (!this.isGraphAvailable(workspaceRoot)) {
      return { available: false, symbolCount: 0, edgeCount: 0, fileCount: 0, dbPath };
    }

    let db: any = null;
    try {
      db = this.getDatabase(workspaceRoot);
      const symbolCount = db.prepare("SELECT COUNT(*) as count FROM symbols").get()?.count || 0;
      const edgeCount = db.prepare("SELECT COUNT(*) as count FROM symbol_edges").get()?.count || 0;
      const fileCount = db.prepare("SELECT COUNT(*) as count FROM files").get()?.count || 0;
      return { available: true, symbolCount, edgeCount, fileCount, dbPath };
    } catch {
      return { available: false, symbolCount: 0, edgeCount: 0, fileCount: 0, dbPath };
    } finally {
      if (db) {
        try { db.close(); } catch {}
      }
    }
  }

  public searchSymbols(
    workspaceRoot: string,
    query: string,
    limit = 25,
    category: "callables" | "types" | "data" | "containers" | "all" | "files" = "callables",
    fileFilter?: string
  ): GraphSymbol[] {
    if (!this.isGraphAvailable(workspaceRoot)) {
      return [];
    }
    const db = this.getDatabase(workspaceRoot);
    try {
      if (category === "files") {
        const sql = `
          SELECT DISTINCT path FROM files WHERE path LIKE ? ORDER BY LENGTH(path) ASC LIMIT ?
        `;
        const rows = db.prepare(sql).all(`%${query}%`, limit);
        return rows.map((r: any) => ({
          id: r.path,
          name: path.basename(r.path),
          qualifiedName: r.path,
          kind: "file",
          language: path.extname(r.path).replace(".", "") || "unknown",
          path: r.path,
          startLine: 1,
          endLine: 1,
          callerCount: 0,
          calleeCount: 0,
        }));
      }

      let kindFilter = "";
      if (category === "callables") {
        kindFilter = "AND LOWER(s.kind) IN ('function', 'method', 'constructor', 'macro', 'class', 'struct')";
      } else if (category === "types") {
        kindFilter = "AND LOWER(s.kind) IN ('class', 'struct', 'interface', 'trait', 'enum', 'type_alias')";
      } else if (category === "data") {
        kindFilter = "AND LOWER(s.kind) IN ('variable', 'constant', 'field', 'property', 'parameter', 'enum_member')";
      } else if (category === "containers") {
        kindFilter = "AND LOWER(s.kind) IN ('file', 'module', 'namespace', 'package')";
      }

      const fileClause = fileFilter ? "AND f.path LIKE ?" : "";
      const sql = `
        SELECT 
          hex(s.symbol_id) as id,
          s.name,
          s.qualified_name,
          s.kind,
          s.language,
          f.path,
          s.range_start_line,
          s.range_end_line,
          s.signature,
          s.visibility,
          s.exported,
          (SELECT COUNT(*) FROM symbol_edges e WHERE e.target = s.symbol_id AND e.kind = 'calls') as caller_count,
          (SELECT COUNT(*) FROM symbol_edges e WHERE e.source = s.symbol_id AND e.kind = 'calls') as callee_count
        FROM symbols s
        JOIN files f ON s.file_id = f.file_id
        WHERE (s.name LIKE ? OR s.qualified_name LIKE ?) ${kindFilter} ${fileClause}
        ORDER BY (caller_count + callee_count) DESC, s.name ASC
        LIMIT ?
      `;

      const wildcard = `%${query}%`;
      const params = fileFilter ? [wildcard, wildcard, `%${fileFilter}%`, limit] : [wildcard, wildcard, limit];
      const rows = db.prepare(sql).all(...params);
      return rows.map((r: any) => this.mapSymbolRow(r));
    } finally {
      try { db.close(); } catch {}
    }
  }

  public getTopSymbols(workspaceRoot: string, limit = 15): GraphSymbol[] {
    const db = this.getDatabase(workspaceRoot);
    try {
      const sql = `
        SELECT 
          hex(s.symbol_id) as id,
          s.name,
          s.qualified_name,
          s.kind,
          s.language,
          f.path,
          s.range_start_line,
          s.range_end_line,
          s.signature,
          s.visibility,
          s.exported,
          (SELECT COUNT(*) FROM symbol_edges e WHERE e.target = s.symbol_id AND e.kind = 'calls') as caller_count,
          (SELECT COUNT(*) FROM symbol_edges e WHERE e.source = s.symbol_id AND e.kind = 'calls') as callee_count
        FROM symbols s
        JOIN files f ON s.file_id = f.file_id
        WHERE s.kind IN ('function', 'method', 'class', 'interface')
        ORDER BY (caller_count + callee_count) DESC, s.name ASC
        LIMIT ?
      `;

      const rows = db.prepare(sql).all(limit);
      return rows.map((r: any) => this.mapSymbolRow(r));
    } finally {
      try { db.close(); } catch {}
    }
  }

  public getCallHierarchy(
    workspaceRoot: string,
    symbolName: string,
    options: { maxCallers?: number; maxCallees?: number } = {}
  ): CallHierarchyResult {
    const db = this.getDatabase(workspaceRoot);
    try {
      const maxCallers = options.maxCallers || 50;
      const maxCallees = options.maxCallees || 50;

      // 1. Find root symbol
      const rootRow = db.prepare(`
        SELECT 
          hex(s.symbol_id) as id,
          s.name,
          s.qualified_name,
          s.kind,
          s.language,
          f.path,
          s.range_start_line,
          s.range_end_line,
          s.signature,
          s.visibility,
          s.exported,
          (SELECT COUNT(*) FROM symbol_edges e WHERE e.target = s.symbol_id AND e.kind = 'calls') as caller_count,
          (SELECT COUNT(*) FROM symbol_edges e WHERE e.source = s.symbol_id AND e.kind = 'calls') as callee_count
        FROM symbols s
        JOIN files f ON s.file_id = f.file_id
        WHERE s.name = ? OR s.qualified_name = ?
        LIMIT 1
      `).get(symbolName, symbolName);

      if (!rootRow) {
        throw new Error(`Symbol '${symbolName}' not found in code graph.`);
      }

      const root = this.mapSymbolRow(rootRow);
      const rootIdBlob = this.hexToBlob(root.id);

      // 2. Find incoming callers (upstream) - GROUP BY s.symbol_id ensures unique callers
      const callerRows = db.prepare(`
        SELECT 
          hex(s.symbol_id) as id,
          s.name,
          s.qualified_name,
          s.kind,
          s.language,
          f.path,
          s.range_start_line,
          s.range_end_line,
          s.signature,
          s.visibility,
          s.exported,
          (SELECT COUNT(*) FROM symbol_edges e2 WHERE e2.target = s.symbol_id AND e2.kind = 'calls') as caller_count,
          (SELECT COUNT(*) FROM symbol_edges e2 WHERE e2.source = s.symbol_id AND e2.kind = 'calls') as callee_count
        FROM symbol_edges e
        JOIN symbols s ON e.source = s.symbol_id
        JOIN files f ON s.file_id = f.file_id
        WHERE e.target = ? AND e.kind = 'calls'
        GROUP BY s.symbol_id
        LIMIT ?
      `).all(rootIdBlob, maxCallers);

      // 3. Find outgoing callees (downstream) - GROUP BY s.symbol_id ensures unique callees
      const calleeRows = db.prepare(`
        SELECT 
          hex(s.symbol_id) as id,
          s.name,
          s.qualified_name,
          s.kind,
          s.language,
          f.path,
          s.range_start_line,
          s.range_end_line,
          s.signature,
          s.visibility,
          s.exported,
          (SELECT COUNT(*) FROM symbol_edges e2 WHERE e2.target = s.symbol_id AND e2.kind = 'calls') as caller_count,
          (SELECT COUNT(*) FROM symbol_edges e2 WHERE e2.source = s.symbol_id AND e2.kind = 'calls') as callee_count
        FROM symbol_edges e
        JOIN symbols s ON e.target = s.symbol_id
        JOIN files f ON s.file_id = f.file_id
        WHERE e.source = ? AND e.kind = 'calls'
        GROUP BY s.symbol_id
        LIMIT ?
      `).all(rootIdBlob, maxCallees);

      const rawCallers = callerRows.map((r: any) => this.mapSymbolRow(r));
      const rawCallees = calleeRows.map((r: any) => this.mapSymbolRow(r));

      // Deduplicate symbols by unique id/location to guarantee zero duplicate cards
      const callers: GraphSymbol[] = Array.from(
        new Map<string, GraphSymbol>(rawCallers.map((c: GraphSymbol) => [c.id || `${c.path}:${c.startLine}:${c.name}`, c])).values()
      );
      const callees: GraphSymbol[] = Array.from(
        new Map<string, GraphSymbol>(rawCallees.map((c: GraphSymbol) => [c.id || `${c.path}:${c.startLine}:${c.name}`, c])).values()
      );

      const edgeMap = new Map<string, GraphEdge>();
      for (const c of callers) {
        const edgeId = `edge_${c.name}_${root.name}`;
        edgeMap.set(edgeId, {
          id: edgeId,
          source: c.name,
          target: root.name,
          kind: "calls",
        });
      }
      for (const c of callees) {
        const edgeId = `edge_${root.name}_${c.name}`;
        edgeMap.set(edgeId, {
          id: edgeId,
          source: root.name,
          target: c.name,
          kind: "calls",
        });
      }

      return { root, callers, callees, edges: Array.from(edgeMap.values()) };
    } finally {
      try { db.close(); } catch {}
    }
  }

  /**
   * Convenience helper used by the CEGAR verifier: returns only the list of
   * symbols that directly call `symbolName` in the Atlas code graph.
   * Returns an empty array if the symbol is not found (graceful fallback).
   */
  public getCallers(workspaceRoot: string, symbolName: string): GraphSymbol[] {
    try {
      const result = this.getCallHierarchy(workspaceRoot, symbolName, { maxCallers: 50 });
      return result.callers;
    } catch {
      return [];
    }
  }

  public expandBranch(
    workspaceRoot: string,
    symbolName: string,
    direction: "callers" | "callees" = "callees",
    limit = 50
  ): { symbols: GraphSymbol[]; edges: GraphEdge[] } {
    const db = this.getDatabase(workspaceRoot);
    try {
      const rootRow = db.prepare("SELECT hex(symbol_id) as id FROM symbols WHERE name = ? LIMIT 1").get(symbolName);
      if (!rootRow) {
        return { symbols: [], edges: [] };
      }

      const symbolIdBlob = this.hexToBlob(rootRow.id);

      if (direction === "callers") {
        const rows = db.prepare(`
          SELECT 
            hex(s.symbol_id) as id,
            s.name,
            s.qualified_name,
            s.kind,
            s.language,
            f.path,
            s.range_start_line,
            s.range_end_line,
            s.signature,
            s.visibility,
            s.exported,
            (SELECT COUNT(*) FROM symbol_edges e2 WHERE e2.target = s.symbol_id AND e2.kind = 'calls') as caller_count,
            (SELECT COUNT(*) FROM symbol_edges e2 WHERE e2.source = s.symbol_id AND e2.kind = 'calls') as callee_count
          FROM symbol_edges e
          JOIN symbols s ON e.source = s.symbol_id
          JOIN files f ON s.file_id = f.file_id
          WHERE e.target = ? AND e.kind = 'calls'
          GROUP BY s.symbol_id
          LIMIT ?
        `).all(symbolIdBlob, limit);

        const rawSymbols = rows.map((r: any) => this.mapSymbolRow(r));
        const symbols: GraphSymbol[] = Array.from(
          new Map<string, GraphSymbol>(rawSymbols.map((s: GraphSymbol) => [s.id || `${s.path}:${s.startLine}:${s.name}`, s])).values()
        );
        const edgeMap = new Map<string, GraphEdge>();
        for (const s of symbols) {
          const edgeId = `edge_${s.name}_${symbolName}`;
          edgeMap.set(edgeId, {
            id: edgeId,
            source: s.name,
            target: symbolName,
            kind: "calls",
          });
        }
        return { symbols, edges: Array.from(edgeMap.values()) };
      } else {
        const rows = db.prepare(`
          SELECT 
            hex(s.symbol_id) as id,
            s.name,
            s.qualified_name,
            s.kind,
            s.language,
            f.path,
            s.range_start_line,
            s.range_end_line,
            s.signature,
            s.visibility,
            s.exported,
            (SELECT COUNT(*) FROM symbol_edges e2 WHERE e2.target = s.symbol_id AND e2.kind = 'calls') as caller_count,
            (SELECT COUNT(*) FROM symbol_edges e2 WHERE e2.source = s.symbol_id AND e2.kind = 'calls') as callee_count
          FROM symbol_edges e
          JOIN symbols s ON e.target = s.symbol_id
          JOIN files f ON s.file_id = f.file_id
          WHERE e.source = ? AND e.kind = 'calls'
          GROUP BY s.symbol_id
          LIMIT ?
        `).all(symbolIdBlob, limit);

        const rawSymbols = rows.map((r: any) => this.mapSymbolRow(r));
        const symbols: GraphSymbol[] = Array.from(
          new Map<string, GraphSymbol>(rawSymbols.map((s: GraphSymbol) => [s.id || `${s.path}:${s.startLine}:${s.name}`, s])).values()
        );
        const edgeMap = new Map<string, GraphEdge>();
        for (const s of symbols) {
          const edgeId = `edge_${symbolName}_${s.name}`;
          edgeMap.set(edgeId, {
            id: edgeId,
            source: symbolName,
            target: s.name,
            kind: "calls",
          });
        }
        return { symbols, edges: Array.from(edgeMap.values()) };
      }
    } finally {
      try { db.close(); } catch {}
    }
  }

  public findPath(
    workspaceRoot: string,
    fromName: string,
    toName: string,
    options: { maxDepth?: number; preferProduction?: boolean } = {}
  ): PathResult {
    const db = this.getDatabase(workspaceRoot);
    try {
      const maxDepth = options.maxDepth || 6;
      const preferProd = options.preferProduction !== false;

      const findBfs = (startName: string, endName: string): { found: boolean; path: string[] } => {
        const fromRow = db.prepare(`
          SELECT hex(s.symbol_id) as id, s.name FROM symbols s WHERE s.name = ? OR s.qualified_name = ? LIMIT 1
        `).get(startName, startName);
        const toRow = db.prepare(`
          SELECT hex(s.symbol_id) as id, s.name FROM symbols s WHERE s.name = ? OR s.qualified_name = ? LIMIT 1
        `).get(endName, endName);

        if (!fromRow || !toRow) return { found: false, path: [] };

        const visited = new Set<string>();
        const queue: { id: string; name: string; path: string[] }[] = [
          { id: fromRow.id, name: fromRow.name, path: [fromRow.name] },
        ];
        visited.add(fromRow.id);

        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current.id === toRow.id || current.name === endName) {
            return { found: true, path: current.path };
          }
          if (current.path.length >= maxDepth) continue;

          const neighbors = db.prepare(`
            SELECT hex(s.symbol_id) as id, s.name, f.path
            FROM symbol_edges e
            JOIN symbols s ON e.target = s.symbol_id
            JOIN files f ON s.file_id = f.file_id
            WHERE e.source = ? AND e.kind = 'calls'
            GROUP BY s.symbol_id
          `).all(this.hexToBlob(current.id));

          if (preferProd) {
            neighbors.sort((a: any, b: any) => {
              const aTest = a.path.includes("test") || a.path.includes("spec") ? 1 : 0;
              const bTest = b.path.includes("test") || b.path.includes("spec") ? 1 : 0;
              return aTest - bTest;
            });
          }

          for (const n of neighbors) {
            if (!visited.has(n.id)) {
              visited.add(n.id);
              queue.push({ id: n.id, name: n.name, path: [...current.path, n.name] });
            }
          }
        }
        return { found: false, path: [] };
      };

      const forwardRes = findBfs(fromName, toName);
      let reversePathFound = false;

      if (!forwardRes.found) {
        const reverseRes = findBfs(toName, fromName);
        reversePathFound = reverseRes.found;
      }

      if (!forwardRes.found) {
        return {
          found: false,
          from: fromName,
          to: toName,
          pathsCount: 0,
          steps: [],
          edges: [],
          reversePathFound,
        };
      }

      const steps: PathStep[] = [];
      const edges: GraphEdge[] = [];
      for (let i = 0; i < forwardRes.path.length; i++) {
        const symRow = db.prepare(`
          SELECT hex(s.symbol_id) as id, s.name, s.qualified_name, s.kind, s.language, f.path, s.range_start_line, s.range_end_line, s.signature
          FROM symbols s JOIN files f ON s.file_id = f.file_id WHERE s.name = ? LIMIT 1
        `).get(forwardRes.path[i]);

        if (symRow) {
          const symbol = this.mapSymbolRow(symRow);
          steps.push({ symbol, callType: i === 0 ? "entry" : i === forwardRes.path.length - 1 ? "sink" : "call" });
        }

        if (i > 0) {
          edges.push({
            id: `path_${forwardRes.path[i - 1]}_${forwardRes.path[i]}`,
            source: forwardRes.path[i - 1],
            target: forwardRes.path[i],
            kind: "calls",
          });
        }
      }

      return {
        found: true,
        from: fromName,
        to: toName,
        pathsCount: 1,
        steps,
        edges,
        reversePathFound: false,
      };
    } finally {
      try { db.close(); } catch {}
    }
  }

  public findAttackPath(workspaceRoot: string, fromName: string, toName: string): PathResult {
    return this.findPath(workspaceRoot, fromName, toName);
  }

  public analyzeImpact(
    workspaceRoot: string,
    symbolName: string,
    direction: "downstream" | "upstream" = "downstream",
    maxDepth = 3,
    limitPerLevel = 12
  ): ImpactResult {
    const db = this.getDatabase(workspaceRoot);
    try {
      const rootRow = db.prepare(`
        SELECT hex(s.symbol_id) as id, s.name, s.qualified_name, s.kind, s.language, f.path, s.range_start_line, s.range_end_line, s.signature
        FROM symbols s JOIN files f ON s.file_id = f.file_id WHERE s.name = ? OR s.qualified_name = ? LIMIT 1
      `).get(symbolName, symbolName);

      if (!rootRow) {
        throw new Error(`Symbol '${symbolName}' not found in code graph.`);
      }

      const target = this.mapSymbolRow(rootRow);
      const levels: ImpactLevel[] = [];
      const allEdges: GraphEdge[] = [];
      const visited = new Set<string>([target.name]);
      let currentFrontier = [rootRow.id];

      for (let depth = 1; depth <= Math.min(maxDepth, 4); depth++) {
        const nextFrontierMap = new Map<string, any>();
        const levelEdges: GraphEdge[] = [];

        for (const currentId of currentFrontier) {
          const currentIdBlob = this.hexToBlob(currentId);
          const currentSym = db.prepare("SELECT name FROM symbols WHERE symbol_id = ?").get(currentIdBlob)?.name || symbolName;
          const query = direction === "downstream"
            ? `
              SELECT hex(s.symbol_id) as id, s.name, s.qualified_name, s.kind, s.language, f.path, s.range_start_line, s.range_end_line, s.signature
              FROM symbol_edges e
              JOIN symbols s ON e.target = s.symbol_id
              JOIN files f ON s.file_id = f.file_id
              WHERE e.source = ? AND e.kind = 'calls'
              GROUP BY s.symbol_id
              LIMIT ?
            `
            : `
              SELECT hex(s.symbol_id) as id, s.name, s.qualified_name, s.kind, s.language, f.path, s.range_start_line, s.range_end_line, s.signature
              FROM symbol_edges e
              JOIN symbols s ON e.source = s.symbol_id
              JOIN files f ON s.file_id = f.file_id
              WHERE e.target = ? AND e.kind = 'calls'
              GROUP BY s.symbol_id
              LIMIT ?
            `;

          const neighbors = db.prepare(query).all(currentIdBlob, limitPerLevel * 2);
          for (const n of neighbors) {
            if (!visited.has(n.name)) {
              nextFrontierMap.set(n.name, n);
              const edgeId = direction === "downstream" ? `edge_${currentSym}_${n.name}` : `edge_${n.name}_${currentSym}`;
              if (!levelEdges.some(e => e.id === edgeId)) {
                levelEdges.push({
                  id: edgeId,
                  source: direction === "downstream" ? currentSym : n.name,
                  target: direction === "downstream" ? n.name : currentSym,
                  kind: "calls",
                });
              }
            }
          }
        }

        if (nextFrontierMap.size === 0) break;

        const levelNodes: GraphSymbol[] = [];
        const nextIds: string[] = [];
        for (const n of Array.from(nextFrontierMap.values())) {
          if (levelNodes.length < limitPerLevel) {
            levelNodes.push(this.mapSymbolRow(n));
            nextIds.push(n.id);
            visited.add(n.name);
          }
        }

        levels.push({
          level: depth,
          label: `Ring ${depth} (${direction === "downstream" ? "Callees" : "Callers"})`,
          totalCount: nextFrontierMap.size,
          nodes: levelNodes,
        });

        allEdges.push(...levelEdges);
        currentFrontier = nextIds;
      }

      const totalAffected = levels.reduce((acc, l) => acc + l.totalCount, 0);

      return {
        target,
        direction,
        maxDepth,
        totalAffected,
        levels,
        edges: allEdges,
      };
    } finally {
      try { db.close(); } catch {}
    }
  }

  public getFileDependencies(
    workspaceRoot: string,
    fileFilter?: string,
    limit = 50
  ): FileDependenciesResult {
    const db = this.getDatabase(workspaceRoot);
    let edgeRows: any[] = [];
    try {
      const edgesQuery = `
        SELECT DISTINCT 
          f_src.path as source_path,
          f_tgt.path as target_path
        FROM symbol_edges e
        JOIN symbols s_src ON e.source = s_src.symbol_id
        JOIN files f_src ON s_src.file_id = f_src.file_id
        JOIN symbols s_tgt ON e.target = s_tgt.symbol_id
        JOIN files f_tgt ON s_tgt.file_id = f_tgt.file_id
        WHERE f_src.path != f_tgt.path
        LIMIT ?
      `;

      edgeRows = db.prepare(edgesQuery).all(limit * 4);
    } finally {
      try { db.close(); } catch {}
    }
    const fileDepMap = new Map<string, Set<string>>();
    const allFiles = new Set<string>();

    for (const r of edgeRows) {
      const src = r.source_path.replace(/\\/g, "/");
      const tgt = r.target_path.replace(/\\/g, "/");
      if (fileFilter && !src.includes(fileFilter) && !tgt.includes(fileFilter)) continue;

      allFiles.add(src);
      allFiles.add(tgt);
      if (!fileDepMap.has(src)) fileDepMap.set(src, new Set());
      fileDepMap.get(src)!.add(tgt);
    }

    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recStack: string[] = [];

    const dfsCycle = (curr: string) => {
      visited.add(curr);
      recStack.push(curr);

      const neighbors = fileDepMap.get(curr) || new Set<string>();
      for (const n of Array.from(neighbors)) {
        if (recStack.includes(n)) {
          const idx = recStack.indexOf(n);
          const cycle = recStack.slice(idx).concat(n);
          cycles.push(cycle);
        } else if (!visited.has(n)) {
          dfsCycle(n);
        }
      }
      recStack.pop();
    };

    for (const f of Array.from(allFiles)) {
      if (!visited.has(f)) dfsCycle(f);
    }

    const cycleNodesSet = new Set<string>(cycles.flat());
    const nodes: FileDependencyNode[] = [];
    const edges: GraphEdge[] = [];

    for (const f of Array.from(allFiles).slice(0, limit)) {
      const inDegree = Array.from(fileDepMap.values()).filter((targets) => targets.has(f)).length;
      const outDegree = fileDepMap.get(f)?.size || 0;
      nodes.push({
        id: f,
        path: f,
        name: path.basename(f),
        language: path.extname(f).replace(".", "") || "unknown",
        inDegree,
        outDegree,
        isInCycle: cycleNodesSet.has(f),
      });

      const targets = fileDepMap.get(f) || new Set<string>();
      for (const t of Array.from(targets)) {
        edges.push({
          id: `dep_${f}_${t}`,
          source: f,
          target: t,
          kind: "imports",
        });
      }
    }

    return {
      totalFiles: nodes.length,
      totalDependencies: edges.length,
      nodes,
      edges,
      hasCycles: cycles.length > 0,
      cycles: cycles.slice(0, 10),
    };
  }

  public getCodeSnippet(workspaceRoot: string, filePath: string, startLine: number, endLine: number): string {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) {
      return "// Source file not available on host";
    }

    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split(/\r?\n/);
      const start = Math.max(0, startLine - 1);
      const end = Math.min(lines.length, endLine);
      return lines.slice(start, end).join("\n");
    } catch {
      return "// Could not read source content";
    }
  }

  public saveFlowDiagram(workspaceRoot: string, flow: FlowExplainerResult): string {
    const sentinelDir = path.join(workspaceRoot, ".codesentinel");
    if (!fs.existsSync(sentinelDir)) {
      try {
        fs.mkdirSync(sentinelDir, { recursive: true });
      } catch {}
    }
    const flowPath = path.join(sentinelDir, "flow.json");
    try {
      fs.writeFileSync(flowPath, JSON.stringify(flow, null, 2), "utf-8");
    } catch {}
    return flowPath;
  }

  public getSavedFlowDiagram(workspaceRoot: string): FlowExplainerResult | null {
    const sentinelPath = path.join(workspaceRoot, ".codesentinel", "flow.json");
    if (fs.existsSync(sentinelPath)) {
      try {
        return JSON.parse(fs.readFileSync(sentinelPath, "utf-8"));
      } catch {}
    }
    const legacyPath = path.join(workspaceRoot, ".atlas", "flow.json");
    if (fs.existsSync(legacyPath)) {
      try {
        return JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
      } catch {}
    }
    return null;
  }

  public explainFlow(
    workspaceRoot: string,
    topic: string,
    entrySymbol?: string,
    maxSteps: number = 8
  ): FlowExplainerResult {
    if (!this.isGraphAvailable(workspaceRoot)) {
      return {
        topic,
        summary: `Workspace index is not ready yet. Please click 'Index Code Graph' in the toolbar to index your repository.`,
        steps: [],
        mermaidDiagram: "flowchart TD\n  Start[Workspace Not Indexed - Click Index Code Graph]",
        graph: { nodes: [], edges: [] },
      };
    }

    try {
      const query = (entrySymbol || topic || "").trim();
      let candidates = this.searchSymbols(workspaceRoot, query, 10, "callables");

    if (candidates.length === 0 && topic) {
      // Related fallbacks for common architecture topics
      const keywords = topic.toLowerCase().includes("login") || topic.toLowerCase().includes("auth")
        ? ["auth", "login", "signin", "verify", "session", "user", "token"]
        : [topic];
      for (const kw of keywords) {
        candidates = this.searchSymbols(workspaceRoot, kw, 8, "callables");
        if (candidates.length > 0) break;
      }
    }

    if (candidates.length === 0) {
      candidates = this.getTopSymbols(workspaceRoot, 5);
    }

    const startSym = candidates[0];
    if (!startSym) {
      const emptyResult: FlowExplainerResult = {
        topic,
        summary: `No callable symbols found in workspace index for topic "${topic}". Please ensure the codebase has been indexed.`,
        steps: [],
        mermaidDiagram: "flowchart TD\n  Start[No matching symbols indexed]",
        graph: { nodes: [], edges: [] },
      };
      return emptyResult;
    }

    // Trace call hierarchy
    const hierarchy = this.getCallHierarchy(workspaceRoot, startSym.name, {
      maxCallers: 3,
      maxCallees: Math.max(4, maxSteps - 2),
    });

    const orderedSymbols: Array<{ sym: GraphSymbol; role: string; desc: string }> = [];

    // Helper for determining role and semantic description
    const classifyRole = (sym: GraphSymbol, isRoot: boolean): { role: string; desc: string } => {
      const n = (sym.name + " " + sym.path).toLowerCase();
      if (n.includes("route") || n.includes("handler") || n.includes("controller") || n.includes("endpoint") || n.includes("page")) {
        return { role: "entrypoint", desc: `Receives client request and parses parameters in ${path.basename(sym.path)}` };
      }
      if (n.includes("validate") || n.includes("check") || n.includes("schema") || n.includes("sanitize") || n.includes("zod")) {
        return { role: "validator", desc: `Validates input payload data integrity and invariants` };
      }
      if (n.includes("auth") || n.includes("login") || n.includes("verify") || n.includes("password") || n.includes("hash")) {
        return { role: "auth_service", desc: `Authenticates credentials and verifies identity rules` };
      }
      if (n.includes("user") || n.includes("find") || n.includes("query") || n.includes("db") || n.includes("model") || n.includes("repo") || n.includes("prisma")) {
        return { role: "database", desc: `Executes database queries and fetches entity records` };
      }
      if (n.includes("token") || n.includes("jwt") || n.includes("session") || n.includes("cookie") || n.includes("sign")) {
        return { role: "session_token", desc: `Generates secure authentication tokens or session state` };
      }
      return { role: isRoot ? "service" : "internal_operation", desc: `Executes core domain logic for ${sym.name}` };
    };

    // 1. Prepend relevant caller (if any) as entrypoint
    if (hierarchy.callers.length > 0) {
      const caller = hierarchy.callers[0];
      const cls = classifyRole(caller, false);
      orderedSymbols.push({ sym: caller, role: "entrypoint", desc: cls.desc });
    }

    // 2. Add root symbol
    const rootCls = classifyRole(hierarchy.root, true);
    orderedSymbols.push({ sym: hierarchy.root, role: rootCls.role, desc: rootCls.desc });

    // 3. Append callees up to maxSteps
    for (const callee of hierarchy.callees) {
      if (orderedSymbols.length >= maxSteps) break;
      if (!orderedSymbols.some(s => s.sym.name === callee.name)) {
        const cls = classifyRole(callee, false);
        orderedSymbols.push({ sym: callee, role: cls.role, desc: cls.desc });
      }
    }

    // Construct flow steps
    const steps: FlowStep[] = orderedSymbols.map((item, idx) => {
      const s = item.sym;
      const snippet = this.getCodeSnippet(workspaceRoot, s.path, s.startLine, s.startLine + 6);
      return {
        step: idx + 1,
        name: s.name,
        kind: s.kind,
        path: s.path,
        startLine: s.startLine,
        endLine: s.endLine,
        role: item.role,
        description: item.desc,
        snippet,
      };
    });

    // Construct Mermaid diagram
    const mermaidLines = ["flowchart TD"];
    steps.forEach((st) => {
      const cleanName = st.name.replace(/[^a-zA-Z0-9_]/g, "_");
      const label = `"${st.step}. ${st.name} (${st.role})"`;
      mermaidLines.push(`  ${cleanName}[${label}]`);
    });
    for (let i = 0; i < steps.length - 1; i++) {
      const src = steps[i].name.replace(/[^a-zA-Z0-9_]/g, "_");
      const tgt = steps[i + 1].name.replace(/[^a-zA-Z0-9_]/g, "_");
      mermaidLines.push(`  ${src} -->|executes| ${tgt}`);
    }
    const mermaidDiagram = mermaidLines.join("\n");

    // Construct visual graph for Code Graph tab
    const graphNodes = steps.map((st) => ({
      id: st.name,
      name: st.name,
      kind: st.kind,
      path: st.path,
      startLine: st.startLine,
      endLine: st.endLine,
      role: st.role,
      description: st.description,
      step: st.step,
    }));

    const graphEdges: Array<{ id: string; source: string; target: string; label?: string; kind: string }> = [];
    for (let i = 0; i < steps.length - 1; i++) {
      graphEdges.push({
        id: `flow_${steps[i].name}_${steps[i + 1].name}`,
        source: steps[i].name,
        target: steps[i + 1].name,
        label: `step ${i + 1} -> ${i + 2}`,
        kind: "flow",
      });
    }

    const summary = `Flow analysis for "${topic}": Traced ${steps.length} sequential execution stages from entrypoint "${steps[0]?.name}" through "${steps[steps.length - 1]?.name}".`;

    const result: FlowExplainerResult = {
      topic,
      summary,
      entryPoint: steps[0]?.name,
      steps,
      mermaidDiagram,
      graph: { nodes: graphNodes, edges: graphEdges },
    };

    // Save diagram for the Code Graph tab
    this.saveFlowDiagram(workspaceRoot, result);

    return result;
    } catch (err: any) {
      return {
        topic,
        summary: `Unable to trace flow for "${topic}": ${err.message}. Please re-index your workspace.`,
        steps: [],
        mermaidDiagram: "flowchart TD\n  Err[Analysis Error - Reindex Workspace]",
        graph: { nodes: [], edges: [] },
      };
    }
  }

  private mapSymbolRow(r: any): GraphSymbol {
    return {
      id: r.id,
      name: r.name,
      qualifiedName: r.qualified_name || r.name,
      kind: r.kind || "function",
      language: r.language || "unknown",
      path: r.path || "",
      startLine: r.range_start_line || 1,
      endLine: r.range_end_line || 1,
      signature: r.signature || `${r.kind} ${r.name}()`,
      visibility: r.visibility || "public",
      isExported: r.exported === 1,
      callerCount: r.caller_count || 0,
      calleeCount: r.callee_count || 0,
    };
  }
}

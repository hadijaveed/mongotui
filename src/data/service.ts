import type {
  CollectionInfo,
  ConnectionInfo,
  DatabaseInfo,
  DocDiff,
  ExplainSummary,
  FindPage,
  IndexInfo,
  MongoService,
  Namespace,
  ParsedQuery,
  QueryField,
  QueryInput,
  QueryValidation,
  SchemaField,
  SchemaSummary,
} from "../shared/types.ts";
import type { Document, Filter, FindOptions, MongoClient as MongoClientType } from "mongodb";
import { bsonTypeName, BSON, QUERY_PARSER } from "./format.ts";

type MongoApi = typeof import("mongodb");

const processWithBuiltins = process as unknown as { getBuiltinModule?: (name: string) => unknown };
const originalGetBuiltinModule = processWithBuiltins.getBuiltinModule;
if (originalGetBuiltinModule) {
  processWithBuiltins.getBuiltinModule = (name: string) =>
    name === "v8" ? {} : originalGetBuiltinModule.call(process, name);
}
const mongodb = require("mongodb") as MongoApi;
if (originalGetBuiltinModule) processWithBuiltins.getBuiltinModule = originalGetBuiltinModule;

export const QUERY_DEFAULTS: ParsedQuery = {
  filter: {},
  skip: 0,
  limit: 0,
  maxTimeMS: 10_000,
};

const QUERY_FIELDS: QueryField[] = [
  "filter", "project", "sort", "collation", "hint", "skip", "limit", "maxTimeMS",
];

function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (raw.split(/\r?\n/, 1)[0]?.trim() || "operation failed")
    .replace(/^Unexpected/, "unexpected")
    .replace(/\s+in\s+\(.*$/, "") // drop the parser's source-snippet tail
    .replace(/\s+/g, " ");
}

function operationError(action: string, error: unknown): Error {
  return new Error(`${action}: ${shortError(error)}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObject(
  text: string,
  parse: (input: string) => unknown,
  validate: (input: string) => unknown,
): Record<string, unknown> {
  const value = parse(text);
  if (validate(text) === false) throw new Error("invalid document");
  if (!isObject(value)) throw new Error("must be an object");
  return value;
}

function validationError(field: QueryField, text: string): string | undefined {
  if (text.trim() === "") return undefined;
  try {
    if (field === "filter") {
      parseObject(text, QUERY_PARSER.parseFilter, QUERY_PARSER.isFilterValid);
    } else if (field === "project") {
      parseObject(text, QUERY_PARSER.parseProject, QUERY_PARSER.isProjectValid);
    } else if (field === "sort") {
      parseObject(text, QUERY_PARSER.parseSort, QUERY_PARSER.isSortValid);
    } else if (field === "collation") {
      parseObject(text, QUERY_PARSER.parseCollation, QUERY_PARSER.isCollationValid);
    } else if (field === "hint") {
      if (text.trimStart().startsWith("{")) {
        parseObject(text, QUERY_PARSER.parseSort, QUERY_PARSER.isSortValid);
      } else if (!text.trim()) {
        throw new Error("index name is required");
      }
    } else {
      const parsed = field === "skip"
        ? QUERY_PARSER.isSkipValid(text)
        : field === "limit"
          ? QUERY_PARSER.isLimitValid(text)
          : QUERY_PARSER.isMaxTimeMSValid(text);
      if (parsed === false || !Number.isInteger(parsed) || parsed < 0) {
        throw new Error("must be a non-negative integer");
      }
    }
  } catch (error) {
    return shortError(error);
  }
  return undefined;
}

function hostFromUri(uri: string): string {
  const withoutScheme = uri.replace(/^mongodb(?:\+srv)?:\/\//i, "");
  const authority = withoutScheme.split(/[/?]/, 1)[0] ?? withoutScheme;
  return authority.slice(authority.lastIndexOf("@") + 1);
}

function findPlanStage(value: unknown): { stage: string; indexName?: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const stage = typeof record.stage === "string" ? record.stage : undefined;
  if (stage === "IXSCAN" || stage === "COLLSCAN") {
    return { stage, indexName: typeof record.indexName === "string" ? record.indexName : undefined };
  }
  for (const child of Object.values(record)) {
    const found = findPlanStage(child);
    if (found) return found;
  }
  return stage ? { stage } : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createMongoService(uri: string): MongoService {
  const client: MongoClientType = new mongodb.MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  let connected = false;
  let connecting: Promise<void> | null = null;
  const estimateCache = new Map<string, { value: number; expires: number }>();

  const ensureConnected = async (): Promise<void> => {
    if (connected) return;
    if (!connecting) {
      connecting = client.connect().then(() => { connected = true; }).finally(() => { connecting = null; });
    }
    await connecting;
  };

  const withConnection = async <T>(action: string, fn: () => Promise<T>): Promise<T> => {
    try {
      await ensureConnected();
      return await fn();
    } catch (error) {
      throw operationError(action, error);
    }
  };

  const validateQuery = (input: QueryInput): QueryValidation => {
    const result = {} as QueryValidation;
    for (const field of QUERY_FIELDS) {
      const error = validationError(field, input[field]);
      result[field] = error ? { valid: false, error } : { valid: true };
    }
    return result;
  };

  const parseQuery = (input: QueryInput): ParsedQuery => {
    const validation = validateQuery(input);
    const invalid = QUERY_FIELDS.find((field) => !validation[field].valid);
    if (invalid) throw new Error(`${invalid}: ${validation[invalid].error}`);

    const result: ParsedQuery = {
      filter: input.filter.trim() ? QUERY_PARSER.parseFilter(input.filter) as Record<string, unknown> : {},
      skip: input.skip.trim() ? Number(input.skip) : QUERY_DEFAULTS.skip,
      limit: input.limit.trim() ? Number(input.limit) : QUERY_DEFAULTS.limit,
      maxTimeMS: input.maxTimeMS.trim() ? Number(input.maxTimeMS) : QUERY_DEFAULTS.maxTimeMS,
    };
    if (input.project.trim()) result.project = QUERY_PARSER.parseProject(input.project) as Record<string, unknown>;
    if (input.sort.trim()) result.sort = QUERY_PARSER.parseSort(input.sort) as Record<string, unknown>;
    if (input.collation.trim()) result.collation = QUERY_PARSER.parseCollation(input.collation) as Record<string, unknown>;
    if (input.hint.trim()) {
      result.hint = input.hint.trimStart().startsWith("{")
        ? QUERY_PARSER.parseSort(input.hint) as Record<string, unknown>
        : input.hint.trim();
    }
    return result;
  };

  const service: MongoService = {
    async connect(): Promise<ConnectionInfo> {
      return withConnection("connect failed", async () => {
        const started = performance.now();
        await client.db("admin").command({ ping: 1 });
        return { uri, host: hostFromUri(uri), latencyMs: performance.now() - started, ok: true };
      });
    },

    async close(): Promise<void> {
      try {
        await client.close();
        connected = false;
      } catch (error) {
        throw operationError("close failed", error);
      }
    },

    async ping(): Promise<number> {
      return withConnection("ping failed", async () => {
        const started = performance.now();
        await client.db("admin").command({ ping: 1 });
        return performance.now() - started;
      });
    },

    async listDatabases(): Promise<DatabaseInfo[]> {
      return withConnection("list databases failed", async () => {
        const result = await client.db("admin").admin().listDatabases();
        return result.databases.map((db) => ({
          name: db.name,
          sizeOnDisk: typeof db.sizeOnDisk === "number" ? db.sizeOnDisk : null,
        }));
      });
    },

    async listCollections(dbName: string): Promise<CollectionInfo[]> {
      return withConnection("list collections failed", async () => {
        const db = client.db(dbName);
        const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
          .filter(({ name }) => !name.startsWith("system."));
        return Promise.all(collections.map(async ({ name }) => {
          try {
            return { name, estimatedCount: await db.collection(name).estimatedDocumentCount() };
          } catch {
            return { name, estimatedCount: null };
          }
        }));
      });
    },

    async listCollectionNames(dbName: string): Promise<string[]> {
      return withConnection("list collections failed", async () => {
        const db = client.db(dbName);
        return (await db.listCollections({}, { nameOnly: true }).toArray())
          .map(({ name }) => name)
          .filter((name) => !name.startsWith("system."));
      });
    },

    validateQuery,
    parseQuery,

    async runFind(ns: Namespace, query: ParsedQuery, offset: number, pageSize: number): Promise<FindPage> {
      return withConnection("find failed", async () => {
        if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
        if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error("pageSize must be a positive integer");
        const remaining = query.limit > 0 ? Math.max(0, query.limit - offset) : pageSize;
        const effectiveLimit = Math.min(pageSize, remaining);
        const key = `${ns.db}.${ns.coll}`;
        let cached = estimateCache.get(key);
        if (!cached || cached.expires <= Date.now()) {
          try {
            cached = {
              value: await client.db(ns.db).collection(ns.coll).estimatedDocumentCount(),
              expires: Date.now() + 30_000,
            };
            estimateCache.set(key, cached);
          } catch {
            cached = undefined;
          }
        }
        if (effectiveLimit === 0) {
          return { docs: [], offset, exactCount: offset, estimatedTotal: cached?.value ?? null, elapsedMs: 0 };
        }
        const options: FindOptions = { skip: query.skip + offset, limit: effectiveLimit, maxTimeMS: query.maxTimeMS };
        if (query.project) options.projection = query.project;
        if (query.sort) options.sort = query.sort as FindOptions["sort"];
        if (query.collation) options.collation = query.collation as unknown as FindOptions["collation"];
        if (query.hint) options.hint = query.hint as FindOptions["hint"];
        const started = performance.now();
        const docs = await client.db(ns.db).collection(ns.coll)
          .find(query.filter as Filter<Document>, options).toArray() as Record<string, unknown>[];
        const elapsedMs = performance.now() - started;
        return {
          docs,
          offset,
          exactCount: docs.length < effectiveLimit ? offset + docs.length : null,
          estimatedTotal: cached?.value ?? null,
          elapsedMs,
        };
      });
    },

    async countExact(ns: Namespace, query: ParsedQuery, signal?: AbortSignal): Promise<number> {
      return withConnection("count failed", () => client.db(ns.db).collection(ns.coll).countDocuments(
        query.filter as Filter<Document>,
        { maxTimeMS: query.maxTimeMS, signal },
      ));
    },

    async sampleSchema(ns: Namespace, sampleSize = 100): Promise<SchemaSummary> {
      return withConnection("schema sample failed", async () => {
        if (!Number.isInteger(sampleSize) || sampleSize <= 0) throw new Error("sampleSize must be a positive integer");
        const collection = client.db(ns.db).collection(ns.coll);
        let docs: Document[];
        try {
          docs = await collection.aggregate([{ $sample: { size: sampleSize } }]).toArray();
        } catch {
          docs = await collection.find().limit(sampleSize).toArray();
        }
        const stats = new Map<string, { present: number; types: Map<string, number> }>();
        for (const doc of docs) {
          const seen = new Map<string, Set<string>>();
          const note = (path: string, value: unknown, depth: number): void => {
            if (!path || depth > 4) return;
            const types = seen.get(path) ?? new Set<string>();
            types.add(bsonTypeName(value));
            seen.set(path, types);
            if (Array.isArray(value)) {
              for (const entry of value) {
                types.add(bsonTypeName(entry));
                if (isObject(entry)) {
                  for (const [key, child] of Object.entries(entry)) note(`${path}.${key}`, child, depth + 1);
                }
              }
            } else if (isObject(value) && !((value as { _bsontype?: string })._bsontype)) {
              for (const [key, child] of Object.entries(value)) note(`${path}.${key}`, child, depth + 1);
            }
          };
          for (const [key, value] of Object.entries(doc)) note(key, value, 1);
          for (const [path, types] of seen) {
            const stat = stats.get(path) ?? { present: 0, types: new Map<string, number>() };
            stat.present++;
            for (const type of types) stat.types.set(type, (stat.types.get(type) ?? 0) + 1);
            stats.set(path, stat);
          }
        }
        const fields: SchemaField[] = [...stats].map(([path, stat]) => ({
          path,
          types: [...stat.types].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([type]) => type),
          probability: docs.length ? stat.present / docs.length : 0,
        })).sort((a, b) => b.probability - a.probability || a.path.localeCompare(b.path)).slice(0, 200);
        return { ns, sampleSize: docs.length, fields };
      });
    },

    async runAggregate(
      ns: Namespace,
      stages: Record<string, unknown>[],
      maxTimeMS: number,
    ): Promise<{ docs: Record<string, unknown>[]; elapsedMs: number }> {
      return withConnection("aggregate failed", async () => {
        for (const stage of stages) {
          const op = Object.keys(stage)[0];
          if (op === "$out" || op === "$merge") throw new Error("read-only: $out/$merge not allowed");
        }
        const hasLimit = stages.some((stage) => Object.prototype.hasOwnProperty.call(stage, "$limit"));
        const pipeline = hasLimit ? stages : [...stages, { $limit: 500 }];
        const started = performance.now();
        const docs = await client.db(ns.db).collection(ns.coll)
          .aggregate(pipeline as Document[], { maxTimeMS }).toArray() as Record<string, unknown>[];
        return { docs, elapsedMs: performance.now() - started };
      });
    },

    async getDocument(ns: Namespace, id: unknown): Promise<Record<string, unknown> | null> {
      return withConnection("get document failed", async () =>
        await client.db(ns.db).collection(ns.coll).findOne({ _id: id } as Filter<Document>) as Record<string, unknown> | null);
    },

    async insertDocument(ns: Namespace, doc: Record<string, unknown>): Promise<unknown> {
      return withConnection("insert document failed", async () =>
        (await client.db(ns.db).collection(ns.coll).insertOne(doc)).insertedId);
    },

    async updateDocument(ns: Namespace, id: unknown, diff: DocDiff): Promise<void> {
      return withConnection("update document failed", async () => {
        const update: Record<string, unknown> = {};
        if (Object.keys(diff.set).length) update.$set = diff.set;
        if (diff.unset.length) update.$unset = Object.fromEntries(diff.unset.map((path) => [path, 1]));
        if (!Object.keys(update).length) return;
        const result = await client.db(ns.db).collection(ns.coll).updateOne({ _id: id } as Filter<Document>, update);
        if (!result.matchedCount) throw new Error("document not found");
      });
    },

    async deleteDocument(ns: Namespace, id: unknown): Promise<void> {
      return withConnection("delete document failed", async () => {
        const result = await client.db(ns.db).collection(ns.coll).deleteOne({ _id: id } as Filter<Document>);
        if (!result.deletedCount) throw new Error("document not found");
      });
    },

    async listIndexes(ns: Namespace): Promise<IndexInfo[]> {
      return withConnection("list indexes failed", async () => {
        const collection = client.db(ns.db).collection(ns.coll);
        const indexes = await collection.listIndexes().toArray();
        let sizes: Record<string, number> = {};
        try {
          const stats = await client.db(ns.db).command({ collStats: ns.coll });
          if (isObject(stats.indexSizes)) sizes = stats.indexSizes as Record<string, number>;
        } catch { /* Index metadata is still useful without sizes. */ }
        return indexes.map((index) => ({
          name: index.name ?? "unnamed",
          keys: index.key as Record<string, unknown>,
          unique: index.unique === true,
          sizeBytes: typeof sizes[index.name ?? ""] === "number" ? sizes[index.name ?? ""]! : null,
        }));
      });
    },

    async explain(ns: Namespace, query: ParsedQuery): Promise<ExplainSummary> {
      return withConnection("explain failed", async () => {
        const options: FindOptions = { skip: query.skip, maxTimeMS: query.maxTimeMS };
        if (query.limit) options.limit = query.limit;
        if (query.project) options.projection = query.project;
        if (query.sort) options.sort = query.sort as FindOptions["sort"];
        if (query.collation) options.collation = query.collation as unknown as FindOptions["collation"];
        if (query.hint) options.hint = query.hint as FindOptions["hint"];
        const result = await client.db(ns.db).collection(ns.coll)
          .find(query.filter as Filter<Document>, options).explain("executionStats") as unknown as Record<string, unknown>;
        const planner = isObject(result.queryPlanner) ? result.queryPlanner : {};
        const execution = isObject(result.executionStats) ? result.executionStats : {};
        const stage = findPlanStage(planner.winningPlan) ?? { stage: "UNKNOWN" };
        const usedIndex = stage.stage === "IXSCAN" ? stage.indexName ?? null : null;
        return {
          plan: usedIndex ? `IXSCAN (${usedIndex})` : stage.stage,
          docsExamined: numeric(execution.totalDocsExamined),
          keysExamined: numeric(execution.totalKeysExamined),
          nReturned: numeric(execution.nReturned),
          executionMs: numeric(execution.executionTimeMillis),
          usedIndex,
        };
      });
    },

    async findByIdAcrossCollections(dbName: string, id: unknown): Promise<{ coll: string; doc: Record<string, unknown> } | null> {
      return withConnection("reference lookup failed", async () => {
        const db = client.db(dbName);
        const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
          .filter(({ name }) => !name.startsWith("system."));
        const ids: unknown[] = [id];
        if (typeof id === "string" && /^[a-f\d]{24}$/i.test(id)) ids.push(new BSON.ObjectId(id));
        for (const { name } of collections) {
          for (const candidate of ids) {
            try {
              const doc = await db.collection(name).findOne({ _id: candidate } as Filter<Document>);
              if (doc) return { coll: name, doc: doc as Record<string, unknown> };
            } catch { /* One inaccessible collection must not stop reference following. */ }
          }
        }
        return null;
      });
    },
  };
  return service;
}


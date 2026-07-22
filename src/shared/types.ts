/**
 * Shared contracts between the data layer (src/data) and the UI (src/ui, src/state).
 * The data layer must be fully usable and testable without a terminal.
 */

export interface Namespace {
  db: string;
  coll: string;
}

/** Raw text as typed in the query bar. Empty string = unset. */
export interface QueryInput {
  filter: string;
  project: string;
  sort: string;
  collation: string;
  hint: string;
  skip: string;
  limit: string;
  maxTimeMS: string;
}

export const DEFAULT_QUERY_INPUT: QueryInput = {
  filter: "",
  project: "",
  sort: "",
  collation: "",
  hint: "",
  skip: "",
  limit: "",
  maxTimeMS: "",
};

export type QueryField = keyof QueryInput;

export interface FieldValidation {
  valid: boolean;
  /** short, single-line, human-readable */
  error?: string;
}

export type QueryValidation = Record<QueryField, FieldValidation>;

/** Parsed, driver-ready query. Produced only from a fully valid QueryInput. */
export interface ParsedQuery {
  filter: Record<string, unknown>;
  project?: Record<string, unknown>;
  sort?: Record<string, unknown>;
  collation?: Record<string, unknown>;
  hint?: Record<string, unknown> | string;
  skip: number;
  limit: number;
  maxTimeMS: number;
}

export interface FindPage {
  docs: Record<string, unknown>[];
  /** 0-based index of first doc within the full result set */
  offset: number;
  /** exact count of filter matches; null while unknown / still computing */
  exactCount: number | null;
  /** estimatedDocumentCount of the whole collection (fast, metadata) */
  estimatedTotal: number | null;
  elapsedMs: number;
}

export interface SchemaField {
  /** dot path, e.g. "imdb.rating" */
  path: string;
  /** BSON type names seen, most frequent first, e.g. ["double", "int32"] */
  types: string[];
  /** 0..1 fraction of sampled docs containing the field */
  probability: number;
}

export interface SchemaSummary {
  ns: Namespace;
  sampleSize: number;
  fields: SchemaField[];
}

export interface CollectionInfo {
  name: string;
  /** null until counted */
  estimatedCount: number | null;
}

export interface DatabaseInfo {
  name: string;
  sizeOnDisk: number | null;
}

export interface ConnectionInfo {
  uri: string;
  /** display form, credentials stripped, e.g. "localhost:27017" */
  host: string;
  latencyMs: number | null;
  ok: boolean;
}

/** Minimal update computed from an edit round-trip. */
export interface DocDiff {
  set: Record<string, unknown>;
  unset: string[];
}

export interface IndexInfo {
  name: string;
  keys: Record<string, unknown>;
  unique: boolean;
  sizeBytes: number | null;
}

export interface ExplainSummary {
  /** e.g. "COLLSCAN" | "IXSCAN (year_1)" */
  plan: string;
  docsExamined: number | null;
  keysExamined: number | null;
  nReturned: number | null;
  executionMs: number | null;
  usedIndex: string | null;
}

export interface MongoService {
  connect(): Promise<ConnectionInfo>;
  close(): Promise<void>;
  ping(): Promise<number>;

  listDatabases(): Promise<DatabaseInfo[]>;
  listCollections(db: string): Promise<CollectionInfo[]>;
  /** Cheap name-only listing (no per-collection counts) for cross-db search. */
  listCollectionNames(db: string): Promise<string[]>;

  /**
   * Validate every field of a QueryInput. Never throws.
   * Uses mongodb-query-parser validators; empty strings are valid (= defaults).
   */
  validateQuery(input: QueryInput): QueryValidation;

  /**
   * Parse a fully valid QueryInput into driver-ready form.
   * Throws Error with a readable message if any field is invalid.
   */
  parseQuery(input: QueryInput): ParsedQuery;

  /**
   * Run a find. offset/pageSize implement paging on top of query.skip/limit:
   * effective skip = query.skip + offset, effective limit = min(pageSize, remaining query.limit).
   * exactCount resolves lazily — see countExact.
   */
  runFind(ns: Namespace, query: ParsedQuery, offset: number, pageSize: number): Promise<FindPage>;

  /** Exact countDocuments(filter) honoring maxTimeMS. Cancellable via AbortSignal. */
  countExact(ns: Namespace, query: ParsedQuery, signal?: AbortSignal): Promise<number>;

  sampleSchema(ns: Namespace, sampleSize?: number): Promise<SchemaSummary>;

  /**
   * Run a read-only aggregation pipeline. Rejects pipelines containing $out or
   * $merge. Appends { $limit: 500 } when no $limit stage is present.
   */
  runAggregate(
    ns: Namespace,
    stages: Record<string, unknown>[],
    maxTimeMS: number,
  ): Promise<{ docs: Record<string, unknown>[]; elapsedMs: number }>;

  getDocument(ns: Namespace, id: unknown): Promise<Record<string, unknown> | null>;
  insertDocument(ns: Namespace, doc: Record<string, unknown>): Promise<unknown>; // returns _id
  updateDocument(ns: Namespace, id: unknown, diff: DocDiff): Promise<void>;
  deleteDocument(ns: Namespace, id: unknown): Promise<void>;

  listIndexes(ns: Namespace): Promise<IndexInfo[]>;
  explain(ns: Namespace, query: ParsedQuery): Promise<ExplainSummary>;

  /** Search all collections in the db for a doc with this _id (reference following). */
  findByIdAcrossCollections(db: string, id: unknown): Promise<{ coll: string; doc: Record<string, unknown> } | null>;
}

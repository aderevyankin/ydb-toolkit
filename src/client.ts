import {AsyncLocalStorage} from "node:async_hooks";
import {tracingChannel} from "node:diagnostics_channel";
import {StatusIds_StatusCode} from "@ydbjs/api/operation";
import {StatsMode} from "@ydbjs/api/query";
import {TableServiceDefinition} from "@ydbjs/api/table";
import type * as Ydb from "@ydbjs/api/value";
import {Driver} from "@ydbjs/core";
import {query, type Query, type QueryClient} from "@ydbjs/query";
import {fromYdb, toJs, type Value} from "@ydbjs/value";
import {List} from "@ydbjs/value/list";
import {Struct} from "@ydbjs/value/struct";
import {Tuple} from "@ydbjs/value/tuple";
import {openDriver, positiveMs, type ConnectionOptions} from "./connection.js";
import {raceWithHedge, type HedgeAttempt} from "./hedge.js";

export type Logger = (level: "info" | "warn" | "error", event: string, details: Record<string, unknown>) => void;
export interface ClientOptions extends ConnectionOptions {
  logger?: Logger;
}
export interface KeyRead {
  table: string;
  key: Record<string, Value>;
  columns: string[];
  expect?: (row: Record<string, unknown>) => boolean;
}
interface CommonOptions {label?: string; timeoutMs?: number; signal?: AbortSignal}
export type ExecuteOptions = CommonOptions & (
  | {mode?: "write"; hedge?: never}
  | {mode: "read"; hedge?: false | {delayMs?: number; keyRead?: KeyRead}}
);
interface NodeInfo {nodeId: string | null}
interface Outcome {resultSets: unknown[][]; q: Query | null; node: NodeInfo}
type Attempt = HedgeAttempt<Outcome> & {node: NodeInfo; usage: {ru: number | null}};
const makeTable = (driver: Driver) => driver.createClient(TableServiceDefinition);
const typed = (value: Value): {type: Ydb.Type; value: Ydb.Value} => ({type: value.type.encode(), value: value.encode()});
const toRow = (columns: Ydb.Column[], items: Ydb.Value[]): Record<string, unknown> =>
  Object.fromEntries(columns.map((column, i) => [column.name, toJs(fromYdb(items[i]!, column.type!))]));

function keyPath(database: string, read: KeyRead): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(read.table) || Object.keys(read.key).length === 0) {
    throw new Error("KeyRead requires a simple table name and a nonempty full primary key");
  }
  return `${database}/${read.table}`;
}

export class YdbClient {
  private readonly sql: QueryClient;
  private readonly table: ReturnType<typeof makeTable>;
  private readonly context = new AsyncLocalStorage<NodeInfo>();
  private readonly channel = tracingChannel("tracing:ydb:query.execute");
  private readonly lifetime = new AbortController();
  private closing: Promise<void> | null = null;
  private readonly onStart = (message: unknown): void => {
    const holder = this.context.getStore();
    const nodeId = (message as {nodeId?: bigint | number}).nodeId ?? null;
    if (holder && nodeId !== null) {holder.nodeId = String(nodeId);}
  };

  private constructor(private readonly driver: Driver, private readonly options: ClientOptions) {
    this.sql = query(driver, {poolOptions: {minSize: 2, maxSize: 20}});
    this.table = makeTable(driver);
    this.channel.start.subscribe(this.onStart);
  }

  static async connect(options: ClientOptions): Promise<YdbClient> {
    const driver = await openDriver(options);
    try {return new YdbClient(driver, options);}
    catch (error: unknown) {driver.close(); throw error;}
  }

  close(): Promise<void> {
    if (this.closing) {return this.closing;}
    this.lifetime.abort();
    this.channel.start.unsubscribe(this.onStart);
    this.closing = Promise.resolve(this.sql[Symbol.asyncDispose]()).finally(() => this.driver.close());
    return this.closing;
  }

  async execute(yql: string, params: Record<string, Value> = {}, options: ExecuteOptions = {}): Promise<{resultSets: unknown[][]}> {
    this.lifetime.signal.throwIfAborted();
    options.signal?.throwIfAborted();
    const label = options.label ?? "<raw>";
    if (options.mode !== "read" && options.hedge) {throw new Error("Hedging is only allowed for explicit reads");}
    const timeout = positiveMs(options.timeoutMs ?? (options.mode === "read" ? 9000 : 8000));
    if (options.mode !== "read" || options.hedge === false) {
      const value = await this.startAttempt(yql, params, timeout, label, "single", options.mode === "read", options.signal).promise;
      if (value.q) {this.logStats(value.q, value.node.nodeId, label);}
      return {resultSets: value.resultSets};
    }
    const delay = positiveMs(options.hedge?.delayMs ?? 1000);
    if (delay >= timeout) {throw new Error("Hedge delay must be less than timeout");}
    const keyRead = options.hedge?.keyRead ?? null;
    return this.race(label, delay,
      () => this.startAttempt(yql, params, timeout, label, "primary", true, options.signal),
      () => keyRead
        ? this.keyAttempt(keyRead, "readTable", timeout - delay, label, options.signal)
        : this.startAttempt(`/* hedge */\n${yql}`, params, timeout - delay, label, "hedge", true, options.signal),
      keyRead ? "readTable" : "sql");
  }

  async readRow(read: KeyRead, options: CommonOptions & {hedge?: false | {delayMs?: number}} = {}): Promise<{resultSets: unknown[][]}> {
    this.lifetime.signal.throwIfAborted();
    options.signal?.throwIfAborted();
    keyPath(this.driver.database, read);
    const timeout = positiveMs(options.timeoutMs ?? 9000);
    const label = options.label ?? read.table;
    if (options.hedge === false) {
      return {resultSets: (await this.keyAttempt(read, "readRows", timeout, label, options.signal).promise).resultSets};
    }
    const delay = positiveMs(options.hedge?.delayMs ?? 1000);
    if (delay >= timeout) {throw new Error("Hedge delay must be less than timeout");}
    return this.race(label, delay,
      () => this.keyAttempt(read, "readRows", timeout, label, options.signal),
      () => this.keyAttempt(read, "readRows", timeout - delay, label, options.signal), "readRows");
  }

  async bulkUpsert(table: string, row: Record<string, Value>, options: CommonOptions = {}): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    const path = keyPath(this.driver.database, {table, key: row, columns: []});
    const signal = this.signal(AbortSignal.timeout(positiveMs(options.timeoutMs ?? 8000)), options.signal);
    signal.throwIfAborted();
    const started = Date.now();
    try {
      const res = await this.table.bulkUpsert({table: path, rows: typed(new List(new Struct(row)))}, {signal});
      const status = res.operation?.status ?? StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED;
      if (status !== StatusIds_StatusCode.SUCCESS) {
        throw new Error(`BulkUpsert ${StatusIds_StatusCode[status]}: ${(res.operation?.issues ?? []).map(i => i.message).join("; ")}`);
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        this.log("warn", "DB_QUERY_TIMEOUT", {label: options.label ?? table, kind: "bulkUpsert", role: "single",
          nodeId: null, elapsedMs: Date.now() - started});
      }
      throw error;
    }
  }

  private signal(internal: AbortSignal, external?: AbortSignal): AbortSignal {
    return AbortSignal.any([internal, this.lifetime.signal, ...(external ? [external] : [])]);
  }

  private async race(label: string, delay: number, primary: () => Attempt, hedge: () => Attempt, kind: string): Promise<{resultSets: unknown[][]}> {
    const attempts: {primary: Attempt | null; hedge: Attempt | null} = {primary: null, hedge: null};
    const started = Date.now();
    const report = (winner: string): void => this.log("warn", "DB_QUERY_HEDGE", {
      label, winner, kind, elapsedMs: Date.now() - started,
      primaryNode: attempts.primary?.node.nodeId ?? null, hedgeNode: attempts.hedge?.node.nodeId ?? null,
      hedgeRu: attempts.hedge?.usage.ru ?? null,
    });
    try {
      const {value, winner, hedged} = await raceWithHedge(isHedge => {
        const attempt = isHedge ? hedge() : primary();
        attempts[isHedge ? "hedge" : "primary"] = attempt;
        return attempt;
      }, delay);
      if (value.q) {this.logStats(value.q, value.node.nodeId, label);}
      if (hedged) {report(winner);}
      return {resultSets: value.resultSets};
    } catch (error: unknown) {
      if (attempts.hedge) {report("none");}
      throw error;
    }
  }

  private startAttempt(yql: string, params: Record<string, Value>, timeout: number, label: string, role: string, read: boolean, external?: AbortSignal): Attempt {
    const q = this.sql(yql).timeout(timeout).signal(this.signal(new AbortController().signal, external));
    q.idempotent(read);
    if (read) {q.withStats(StatsMode.BASIC);}
    for (const [name, value] of Object.entries(params)) {q.parameter(name, value);}
    const node: NodeInfo = {nodeId: null};
    const started = Date.now();
    const promise = this.context.run(node, async () => await q)
      .then(resultSets => ({resultSets, q, node}))
      .catch((error: unknown) => {
        if (!q.cancelled && error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
          this.log("warn", "DB_QUERY_TIMEOUT", {label, role, nodeId: node.nodeId, elapsedMs: Date.now() - started});
        }
        throw error;
      });
    return {promise, cancel: () => {q.cancel();}, node, usage: {ru: null}};
  }

  private keyAttempt(read: KeyRead, kind: "readRows" | "readTable", timeout: number, label: string, external?: AbortSignal): Attempt {
    const path = keyPath(this.driver.database, read);
    const controller = new AbortController();
    const signal = this.signal(AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]), external);
    const usage: {ru: number | null} = {ru: null};
    const node: NodeInfo = {nodeId: null};
    const started = Date.now();
    const onTrailer = (md: {get: (key: string) => unknown}): void => {
      const ru = Number(md.get("x-ydb-consumed-units") ?? Number.NaN);
      if (Number.isFinite(ru)) {usage.ru = ru;}
    };
    const promise = (async (): Promise<Outcome> => {
      signal.throwIfAborted();
      const rows: Record<string, unknown>[] = [];
      if (kind === "readRows") {
        const result = await this.table.readRows({path, keys: typed(new List(new Struct(read.key))), columns: read.columns}, {signal, onTrailer});
        if (result.status !== StatusIds_StatusCode.SUCCESS) {
          throw new Error(`ReadRows ${StatusIds_StatusCode[result.status]}: ${result.issues.map(i => i.message).join("; ")}`);
        }
        const rs = result.resultSet;
        for (const row of rs?.rows ?? []) {rows.push(toRow(rs!.columns, row.items));}
      } else {
        const key = typed(new Tuple(...Object.values(read.key)));
        for await (const part of this.table.streamReadTable({path, columns: read.columns, rowLimit: 2n,
          keyRange: {fromBound: {case: "greaterOrEqual", value: key}, toBound: {case: "lessOrEqual", value: key}},
        }, {signal, onTrailer})) {
          if (![StatusIds_StatusCode.SUCCESS, StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED].includes(part.status)) {
            throw new Error(`ReadTable ${StatusIds_StatusCode[part.status]}: ${part.issues.map(i => i.message).join("; ")}`);
          }
          const rs = part.result?.resultSet;
          for (const row of rs?.rows ?? []) {rows.push(toRow(rs!.columns, row.items));}
        }
      }
      if (read.expect && !(rows[0] && read.expect(rows[0]))) {throw new Error(`${kind}: no matching row for derived key`);}
      return {resultSets: [rows], q: null, node};
    })().catch((error: unknown) => {
      if (signal.aborted && !controller.signal.aborted) {
        this.log("warn", "DB_QUERY_TIMEOUT", {label, kind, elapsedMs: Date.now() - started});
      }
      throw error;
    });
    return {promise, cancel: () => controller.abort(), node, usage};
  }

  private logStats(q: Query, nodeId: string | null, label: string): void {
    const stats = q.stats();
    const compilation = stats?.compilation;
    if (compilation?.fromCache !== false && Number(stats?.totalDurationUs ?? 0n) < 1000000) {return;}
    this.log("info", "DB_QUERY_STATS", {label, nodeId, fromCache: compilation?.fromCache ?? null,
      compileMs: compilation ? Math.round(Number(compilation.durationUs) / 1000) : null,
      totalMs: Math.round(Number(stats?.totalDurationUs ?? 0n) / 1000)});
  }

  private log(level: "info" | "warn" | "error", event: string, details: Record<string, unknown>): void {
    try {this.options.logger?.(level, event, details);} catch { /* Diagnostics must not change a query outcome. */ }
  }
}

/**
 * Local worker diagnostics.
 *
 * This is deliberately a small adapter around the experimental OTel Logs API.
 * Diagnostics are best-effort: a broken filesystem must never make a model
 * callback fail.  The exporter is also useful on its own in tests and for
 * callers which already have an OTel LoggerProvider.
 */
import { mkdir, open, appendFile, rename } from "node:fs/promises";
import { dirname, basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { Logger } from "@opentelemetry/api-logs";
import { SeverityNumber, logs } from "@opentelemetry/api-logs";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";

export const DIAGNOSTIC_RECORD_VERSION = 1;
export const DEFAULT_DIAGNOSTIC_RECORD_BYTES = 4 * 1024;
export const DEFAULT_DIAGNOSTIC_ROTATION_BYTES = 5 * 1024 * 1024;
export const DEFAULT_DIAGNOSTIC_RETAINED_FILES = 1;

type Primitive = string | number | boolean;
type SafeValue = Primitive | Primitive[];

/** The only attribute names which can be written to a diagnostic file. */
export const APPROVED_DIAGNOSTIC_ATTRIBUTES = new Set([
  "model", "model.provider", "outcome", "reason", "timeout_ms", "hard_timeout_ms", "idle_timeout_ms",
  "input_ids", "input.ids", "input_count", "input.count", "input.turn_id", "input.bootstrap",
  "tool.name", "tool.item_id", "tool.outcome", "tool.duration_ms", "duration_ms", "settlement_delay_ms", "error_count",
  "deadline", "deadline_ms", "actual_firing_time", "last_activity", "reset_reason", "reset_count", "next_expiry",
  "last_raw_event_type", "last_raw_event_time", "last_meaningful_progress_time", "last_meaningful_progress_reason",
  "last_meaningful_progress_item_id", "last_transcript_output_time", "watchdog.armed",
  "watchdog.disabled", "watchdog.fired", "watchdog.latest_reset", "watchdog.reset_count",
  "watchdog.next_expiry", "open_tool_count", "open_tools", "rss_bytes", "cpu_time_delta_ms",
  "watchdog_state", "watchdog_reset_reason", "watchdog_reset_count", "watchdog_next_expiry",
  "channel.state", "channel.transport", "channel.controller_epoch", "channel.worker_generation",
  "channel.close_category", "channel.error_category", "channel.close_code", "channel.accepted",
  "bundle_version",
  "sdk_version", "configuration", "invocation_id", "turn_id", "attempt", "generation", "run_id",
  "diagnostics.seq",
]);

const fsImpl = { mkdir, open, appendFile, rename };
type FsImpl = typeof fsImpl;

export interface DiagnosticsIdentity {
  runId: string | number;
  instanceId: string;
  generation?: string | number;
  attempt?: string | number;
}

export interface JsonlLogRecordExporterOptions extends Partial<DiagnosticsIdentity> {
  /** The intended current file. `sessionRoot` is used when this is omitted. */
  filePath?: string;
  sessionRoot?: string;
  maxRecordBytes?: number;
  rotationBytes?: number;
  retainedFiles?: number;
  streamId?: string;
  /** A test seam; production callers should leave this unset. */
  fs?: Partial<FsImpl>;
  onError?: (error: unknown) => void;
}

export interface DiagnosticRecord {
  v: number;
  time: string;
  seq: number;
  level: string;
  event: string;
  run_id: string | number;
  generation?: string | number;
  attempt?: string | number;
  stream_id: string;
  invocation_id?: string;
  turn_id?: string;
  trace_id?: string;
  span_id?: string;
  attributes?: Record<string, SafeValue>;
}

function safeValue(value: unknown): SafeValue | undefined {
  if (typeof value === "string") return value.length > 512 ? value.slice(0, 512) : value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const values: Primitive[] = [];
    for (const item of value.slice(0, 8)) {
      const safe = safeValue(item);
      if (safe !== undefined && !Array.isArray(safe)) values.push(safe);
    }
    return values;
  }
  return undefined;
}

function safeAttributes(attributes: Record<string, unknown> | undefined): Record<string, SafeValue> | undefined {
  if (!attributes) return undefined;
  const output: Record<string, SafeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!APPROVED_DIAGNOSTIC_ATTRIBUTES.has(key)) continue;
    const safe = safeValue(value);
    if (safe !== undefined) output[key] = safe;
  }
  return Object.keys(output).length ? output : undefined;
}

/** Bound the object before OTel sees it. The SDK limits below are a second
 * guard, not a substitute for this pre-admission bound. */
function boundAdmissionAttributes(
  event: string,
  attributes: Record<string, unknown>,
  maxBytes: number,
): Record<string, SafeValue> {
  const safe = safeAttributes(attributes) ?? {};
  const entries = Object.entries(safe);
  const retained: Record<string, SafeValue> = {};
  for (const [key, value] of entries) {
    const candidate = { body: event.slice(0, 160), attributes: { ...retained, [key]: value } };
    if (byteLength(JSON.stringify(candidate)) <= Math.max(256, maxBytes - 256)) retained[key] = value;
  }
  return retained;
}

function isoTime(record: ReadableLogRecord): string {
  const hr = record.hrTime;
  if (!Array.isArray(hr) || hr.length < 2) return new Date().toISOString();
  const millis = hr[0] * 1_000 + Math.floor(hr[1] / 1_000_000);
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function level(record: ReadableLogRecord): string {
  const text = record.severityText?.trim().toUpperCase();
  if (text) return text;
  const number = record.severityNumber ?? SeverityNumber.UNSPECIFIED;
  if (number >= SeverityNumber.FATAL) return "FATAL";
  if (number >= SeverityNumber.ERROR) return "ERROR";
  if (number >= SeverityNumber.WARN) return "WARN";
  if (number >= SeverityNumber.INFO) return "INFO";
  if (number >= SeverityNumber.DEBUG) return "DEBUG";
  return "UNSPECIFIED";
}

function eventName(record: ReadableLogRecord): string {
  const body = record.body;
  const value = record.eventName ?? (typeof body === "string" || typeof body === "number" ? body : "diagnostic.event");
  return String(value).slice(0, 160);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Asynchronous, rotating JSONL LogRecordExporter. There is intentionally no
 * open file handle: append/rename operations are serialized and a hung append
 * can never make a second write queue behind it.
 */
export class JsonlLogRecordExporter implements LogRecordExporter {
  readonly streamId: string;
  readonly intendedPath: string;
  private currentPath?: string;
  private currentBytes = 0;
  private readonly maxRecordBytes: number;
  private readonly rotationBytes: number;
  private readonly retainedFiles: number;
  private readonly identity: DiagnosticsIdentity;
  private readonly fs: FsImpl;
  private readonly onError?: (error: unknown) => void;
  private sequence = 0;
  private active: Promise<void> | null = null;
  private ready: Promise<void> | null = null;
  private closed = false;
  private dropCount = 0;
  private errorCount = 0;
  private lastErrorReport = 0;

  constructor(options: JsonlLogRecordExporterOptions) {
    if (options.runId === undefined) throw new Error("JsonlLogRecordExporter requires runId");
    if (!options.instanceId) throw new Error("JsonlLogRecordExporter requires instanceId");
    this.identity = { runId: options.runId, instanceId: options.instanceId, generation: options.generation, attempt: options.attempt };
    this.streamId = options.streamId ?? randomUUID();
    const root = options.sessionRoot ?? process.env.SESSION_ROOT ?? process.cwd();
    this.intendedPath = options.filePath ?? join(root, "logs", `diagnostics-${String(options.runId)}-${String(options.instanceId)}.jsonl`);
    this.maxRecordBytes = Math.max(256, options.maxRecordBytes ?? DEFAULT_DIAGNOSTIC_RECORD_BYTES);
    this.rotationBytes = Math.max(this.maxRecordBytes, options.rotationBytes ?? DEFAULT_DIAGNOSTIC_ROTATION_BYTES);
    this.retainedFiles = Math.max(1, Math.floor(options.retainedFiles ?? DEFAULT_DIAGNOSTIC_RETAINED_FILES));
    this.fs = { ...fsImpl, ...(options.fs ?? {}) };
    this.onError = options.onError;
  }

  /** Reserve a sequence before handing a record to the SDK. Queue drops then show as gaps. */
  nextSequence(): number { return ++this.sequence; }

  setIdentity(identity: Partial<DiagnosticsIdentity>): void {
    Object.assign(this.identity, identity);
  }

  get path(): string | undefined { return this.currentPath; }
  get drops(): number { return this.dropCount; }
  get errors(): number { return this.errorCount; }

  export(logsToExport: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    let called = false;
    const done = (result: ExportResult) => { if (!called) { called = true; resultCallback(result); } };
    if (this.closed || this.active) {
      this.dropCount += logsToExport.length;
      done({ code: ExportResultCode.FAILED, error: new Error("diagnostic exporter busy or shut down") });
      return;
    }
    const operation = this.writeBatch(logsToExport);
    this.active = operation;
    operation.then(() => done({ code: ExportResultCode.SUCCESS }), (error) => {
      this.errorCount += Math.max(1, logsToExport.length);
      this.reportError(error);
      done({ code: ExportResultCode.FAILED, error });
    }).finally(() => { if (this.active === operation) this.active = null; }).catch(() => undefined);
  }

  async forceFlush(): Promise<void> {
    const active = this.active;
    if (active) await active.catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.forceFlush();
  }

  private reportError(error: unknown): void {
    const now = Date.now();
    if (this.onError && now - this.lastErrorReport >= 5_000) {
      this.lastErrorReport = now;
      try { this.onError(error); } catch { /* diagnostics cannot recurse into itself */ }
    }
  }

  private async ensureReady(): Promise<void> {
    if (!this.ready) this.ready = this.openCurrent();
    await this.ready;
  }

  private async openCurrent(): Promise<void> {
    await this.fs.mkdir(dirname(this.intendedPath), { recursive: true });
    let path = this.intendedPath;
    try {
      const handle = await this.fs.open(path, "wx");
      await handle.close();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      // The collision suffix is the process stream identity so a reader can
      // correlate the fallback filename with every record it contains.
      path = join(dirname(path), `${basename(path, extname(path))}.${this.streamId}${extname(path)}`);
      const handle = await this.fs.open(path, "wx");
      await handle.close();
    }
    this.currentPath = path;
    this.currentBytes = 0;
  }

  private recordFromOtel(record: ReadableLogRecord): DiagnosticRecord {
    const attributes = safeAttributes(record.attributes as Record<string, unknown>);
    const attr = (key: string) => attributes?.[key];
    const seqValue = attr("diagnostics.seq");
    const seq = typeof seqValue === "number" && Number.isSafeInteger(seqValue) ? seqValue : this.nextSequence();
    this.sequence = Math.max(this.sequence, seq);
    const span = record.spanContext;
    const runId = attr("run_id");
    const generation = attr("generation");
    const attempt = attr("attempt");
    const common: DiagnosticRecord = {
      v: DIAGNOSTIC_RECORD_VERSION,
      time: isoTime(record), seq, level: level(record), event: eventName(record),
      run_id: typeof runId === "string" || typeof runId === "number" ? runId : this.identity.runId, stream_id: this.streamId,
    };
    common.generation = typeof generation === "string" || typeof generation === "number" ? generation : this.identity.generation;
    common.attempt = typeof attempt === "string" || typeof attempt === "number" ? attempt : this.identity.attempt;
    if (common.generation === undefined) delete common.generation;
    if (common.attempt === undefined) delete common.attempt;
    const invocation = attr("invocation_id");
    const turn = attr("turn_id");
    if (typeof invocation === "string") common.invocation_id = invocation;
    if (typeof turn === "string") common.turn_id = turn;
    if (span?.traceId && /^[0-9a-f]{32}$/i.test(span.traceId)) common.trace_id = span.traceId;
    if (span?.spanId && /^[0-9a-f]{16}$/i.test(span.spanId)) common.span_id = span.spanId;
    if (attributes) {
      delete attributes["diagnostics.seq"];
      delete attributes["run_id"];
      delete attributes["generation"];
      delete attributes["attempt"];
      delete attributes["invocation_id"];
      delete attributes["turn_id"];
      if (Object.keys(attributes).length) common.attributes = attributes;
    }
    return common;
  }

  private serialize(record: DiagnosticRecord): string {
    // Keep field order stable. First remove optional payload, then shorten
    // strings until the compact JSON object fits the byte budget.
    const candidate = { ...record, attributes: record.attributes ? { ...record.attributes } : undefined } as Record<string, unknown>;
    let text = JSON.stringify(candidate);
    if (byteLength(text) <= this.maxRecordBytes - 1) return text + "\n";
    delete candidate.attributes;
    text = JSON.stringify(candidate);
    if (byteLength(text) <= this.maxRecordBytes - 1) return text + "\n";
    const event = String(candidate.event).slice(0, 64);
    candidate.event = event;
    candidate.stream_id = String(candidate.stream_id).slice(0, 36);
    text = JSON.stringify(candidate);
    if (byteLength(text) <= this.maxRecordBytes - 1) return text + "\n";
    // Identity values are expected to be tiny, but a defensive final form
    // guarantees that even hostile test input cannot exceed the bound.
    const minimal = { v: 1, time: String(candidate.time).slice(0, 24), seq: candidate.seq, level: String(candidate.level).slice(0, 16), event, run_id: candidate.run_id, stream_id: candidate.stream_id };
    text = JSON.stringify(minimal);
    return byteLength(text) <= this.maxRecordBytes - 1 ? text + "\n" : JSON.stringify({ v: 1, seq: candidate.seq, event: "diagnostic.truncated" }) + "\n";
  }

  private async writeBatch(records: ReadableLogRecord[]): Promise<void> {
    await this.ensureReady();
    const lines = records.map((record) => this.serialize(this.recordFromOtel(record)));
    const drops = this.dropCount;
    const errors = this.errorCount;
    if (drops || errors) {
      const diagnostic: DiagnosticRecord = {
        v: 1, time: new Date().toISOString(), seq: this.nextSequence(), level: "WARN",
        event: "diagnostic.export_drops", run_id: this.identity.runId, stream_id: this.streamId,
        attributes: { "input_count": drops, "error_count": errors, "outcome": "export_failure" },
      };
      lines.push(this.serialize(diagnostic));
    }
    const content = lines.join("");
    if (!this.currentPath) throw new Error("diagnostic exporter has no current path");
    await this.fs.appendFile(this.currentPath, content, "utf8");
    this.dropCount = Math.max(0, this.dropCount - drops);
    this.errorCount = Math.max(0, this.errorCount - errors);
    this.currentBytes += byteLength(content);
    if (this.currentBytes >= this.rotationBytes) await this.rotate();
  }

  private async rotate(): Promise<void> {
    if (!this.currentPath) return;
    const current = this.currentPath;
    // The path's suffix is part of the process stream identity. Keep the
    // process-owned backup adjacent to it, so old incarnations remain intact.
    const backup = `${current}.${this.retainedFiles}`;
    await this.fs.rename(current, backup);
    this.currentPath = undefined;
    this.currentBytes = 0;
    const handle = await this.fs.open(current, "wx");
    await handle.close();
    this.currentPath = current;
  }
}

export interface DiagnosticsOptions extends JsonlLogRecordExporterOptions {
  loggerName?: string;
  instrumentationVersion?: string;
  setGlobal?: boolean;
}

export interface Diagnostics {
  readonly provider: LoggerProvider;
  readonly logger: Logger;
  readonly exporter: JsonlLogRecordExporter;
  emit(event: string, fields?: Record<string, unknown>, options?: { level?: string; invocationId?: string; turnId?: string }): number;
  rawSdkEvent(type: string, at?: number): void;
  meaningfulProgress(reason: string, itemId?: string, at?: number): void;
  transcriptOutput(at?: number): void;
  snapshot(): Record<string, unknown>;
  setAttempt(attempt?: string | number): void;
  setIdentity(identity: Partial<DiagnosticsIdentity>): void;
  forceFlush(timeoutMs?: number): Promise<boolean>;
  shutdown(timeoutMs?: number): Promise<boolean>;
}

function severity(levelName: string): { severityNumber: SeverityNumber; severityText: string } {
  const levelNameUpper = levelName.toUpperCase();
  if (levelNameUpper === "FATAL") return { severityNumber: SeverityNumber.FATAL, severityText: "FATAL" };
  if (levelNameUpper === "ERROR") return { severityNumber: SeverityNumber.ERROR, severityText: "ERROR" };
  if (levelNameUpper === "WARN" || levelNameUpper === "WARNING") return { severityNumber: SeverityNumber.WARN, severityText: "WARN" };
  if (levelNameUpper === "DEBUG") return { severityNumber: SeverityNumber.DEBUG, severityText: "DEBUG" };
  if (levelNameUpper === "TRACE") return { severityNumber: SeverityNumber.TRACE, severityText: "TRACE" };
  return { severityNumber: SeverityNumber.INFO, severityText: "INFO" };
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<{ timedOut: boolean; value?: T }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false, value })),
      new Promise<{ timedOut: true }>((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); timer.unref?.(); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function setupDiagnostics(options: DiagnosticsOptions): Diagnostics {
  const exporter = new JsonlLogRecordExporter(options);
  const processor = new BatchLogRecordProcessor({
    exporter,
    scheduledDelayMillis: 1_000,
    maxQueueSize: 256,
    maxExportBatchSize: 32,
    exportTimeoutMillis: 1_000,
  });
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      "service.name": "task-orchestrator-worker",
      "service.instance.id": options.instanceId,
      "task_orch.run_id": options.runId,
      ...(options.generation === undefined ? {} : { "task_orch.generation": options.generation }),
    }),
    processors: [processor],
    logRecordLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 512 },
  });
  const logger = provider.getLogger(options.loggerName ?? "task-orchestrator.worker", options.instrumentationVersion);
  if (options.setGlobal) logs.setGlobalLoggerProvider(provider);
  let stopped = false;
  let lastRawSdkEventType: string | undefined;
  let lastRawSdkEventAt: number | undefined;
  let lastMeaningfulProgressReason: string | undefined;
  let lastMeaningfulProgressItemId: string | undefined;
  let lastMeaningfulProgressAt: number | undefined;
  let lastTranscriptOutputAt: number | undefined;
  const openTools = new Map<string, { name: string; itemId: string; invocationId?: string; lastOutputAt: number }>();
  let channelState = "disconnected";
  let channelEpoch = 0;
  let priorCpu = process.cpuUsage();
  const identityState: DiagnosticsIdentity = {
    runId: options.runId!, instanceId: options.instanceId!, generation: options.generation, attempt: options.attempt,
  };
  const now = () => Date.now();
  return {
    provider, logger, exporter,
    emit(event, fields = {}, emitOptions = {}) {
      if (stopped) return 0;
      const seq = exporter.nextSequence();
      // Include identity on every record so an attempt update cannot relabel
      // records already admitted to a batch that has not written yet.
      const attrs: Record<string, unknown> = {
        ...fields,
        run_id: identityState.runId,
        ...(identityState.generation === undefined ? {} : { generation: identityState.generation }),
        ...(identityState.attempt === undefined ? {} : { attempt: identityState.attempt }),
        "diagnostics.seq": seq,
      };
      if (emitOptions.invocationId) attrs.invocation_id = emitOptions.invocationId;
      if (emitOptions.turnId) attrs.turn_id = emitOptions.turnId;
      const bounded = boundAdmissionAttributes(event, attrs, options.maxRecordBytes ?? DEFAULT_DIAGNOSTIC_RECORD_BYTES);
      const toolName = typeof bounded["tool.name"] === "string" ? bounded["tool.name"] : undefined;
      const toolId = typeof bounded["tool.item_id"] === "string" ? bounded["tool.item_id"] : undefined;
      const invocationId = typeof bounded.invocation_id === "string" ? bounded.invocation_id : undefined;
      const toolKey = toolId ? `${invocationId ?? "unknown"}:${toolId}` : undefined;
      if (event === "tool.started" && toolId && toolKey) {
        openTools.set(toolKey, { name: toolName ?? "unknown", itemId: toolId, invocationId, lastOutputAt: now() });
      }
      if (event === "tool.finished" && toolKey) openTools.delete(toolKey);
      const eventEpoch = typeof bounded["channel.controller_epoch"] === "number"
        ? bounded["channel.controller_epoch"]
        : 0;
      if (event === "channel.connected" && eventEpoch >= channelEpoch) {
        channelEpoch = eventEpoch;
        channelState = "connected";
      }
      if (event === "channel.disconnected" && eventEpoch >= channelEpoch) {
        channelEpoch = eventEpoch;
        channelState = "disconnected";
      }
      const sev = severity(emitOptions.level ?? "INFO");
      try {
        logger.emit({ body: event, eventName: event, attributes: bounded as never, severityNumber: sev.severityNumber, severityText: sev.severityText });
      } catch {
        // A provider or processor failure is diagnostic loss, never a run failure.
      }
      return seq;
    },
    rawSdkEvent(type, at = now()) { lastRawSdkEventType = type.slice(0, 160); lastRawSdkEventAt = at; },
    meaningfulProgress(reason, itemId, at = now()) {
      lastMeaningfulProgressReason = reason.slice(0, 200);
      lastMeaningfulProgressItemId = itemId?.slice(0, 200);
      lastMeaningfulProgressAt = at;
      if (itemId) {
        for (const tool of openTools.values()) {
          if (tool.itemId === itemId) tool.lastOutputAt = at;
        }
      }
    },
    transcriptOutput(at = now()) { lastTranscriptOutputAt = at; },
    snapshot() {
      const cpu = process.cpuUsage(priorCpu);
      priorCpu = process.cpuUsage();
      return {
        ...(lastRawSdkEventType ? { last_raw_event_type: lastRawSdkEventType } : {}),
        ...(lastRawSdkEventAt === undefined ? {} : { last_raw_event_time: new Date(lastRawSdkEventAt).toISOString() }),
        ...(lastMeaningfulProgressReason ? { last_meaningful_progress_reason: lastMeaningfulProgressReason } : {}),
        ...(lastMeaningfulProgressItemId ? { last_meaningful_progress_item_id: lastMeaningfulProgressItemId } : {}),
        ...(lastMeaningfulProgressAt === undefined ? {} : { last_meaningful_progress_time: new Date(lastMeaningfulProgressAt).toISOString() }),
        ...(lastTranscriptOutputAt === undefined ? {} : { last_transcript_output_time: new Date(lastTranscriptOutputAt).toISOString() }),
        open_tool_count: openTools.size,
        open_tools: [...openTools.values()].slice(0, 8).map((tool) =>
          `${tool.invocationId ?? "unknown"}:${tool.name}:${tool.itemId}:${tool.lastOutputAt}`
        ),
        rss_bytes: process.memoryUsage.rss(),
        cpu_time_delta_ms: (cpu.user + cpu.system) / 1_000,
        "channel.state": channelState,
      };
    },
    setAttempt(attempt) { exporter.setIdentity({ attempt }); identityState.attempt = attempt; },
    setIdentity(identity) { exporter.setIdentity(identity); Object.assign(identityState, identity); },
    async forceFlush(timeoutMs = 1_000) {
      if (stopped) return true;
      const result = await bounded(provider.forceFlush({ timeoutMillis: timeoutMs }), timeoutMs);
      return !result.timedOut;
    },
    async shutdown(timeoutMs = 1_000) {
      stopped = true;
      const result = await bounded(provider.shutdown(), timeoutMs);
      return !result.timedOut;
    },
  };
}

export const createDiagnostics = setupDiagnostics;
export const createWorkerDiagnosticsLogger = setupDiagnostics;

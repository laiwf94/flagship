import {
  ErrorCode,
  OpenFeatureEventEmitter,
  ProviderEvents,
  StandardResolutionReasons,
  type EvaluationContext,
  type JsonValue,
  type Provider,
  type ResolutionDetails,
} from '@openfeature/server-sdk';
import type { Context, ContextValue, Flag } from '@flagship/core';
import {
  FlagshipClient,
  type ClientOptions,
  type Detail,
  type ErrorCode as SdkErrorCode,
} from './client.js';

const ERROR_CODES: Record<SdkErrorCode, ErrorCode> = {
  FLAG_NOT_FOUND: ErrorCode.FLAG_NOT_FOUND,
  TYPE_MISMATCH: ErrorCode.TYPE_MISMATCH,
  PROVIDER_NOT_READY: ErrorCode.PROVIDER_NOT_READY,
  INVALID_CONTEXT: ErrorCode.INVALID_CONTEXT,
  PREREQUISITE_CYCLE: ErrorCode.GENERAL,
  MALFORMED_FLAG: ErrorCode.PARSE_ERROR,
};

type Scalar = string | number | boolean;

function scalar(v: unknown): Scalar | undefined {
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v instanceof Date) return v.toISOString();
  return undefined;
}

/**
 * Maps an OpenFeature evaluation context to a flagship context:
 * `targetingKey` becomes `key`, scalar attributes pass through, dates become
 * ISO strings, lists keep their scalar elements, nested objects are dropped
 * (flagship attributes are flat).
 */
export function toContext(ctx: EvaluationContext): Context | undefined {
  const key = ctx.targetingKey;
  if (typeof key !== 'string' || key === '') return undefined;
  const out: Context = { key };
  for (const [name, value] of Object.entries(ctx)) {
    if (name === 'targetingKey' || name === 'key') continue;
    if (Array.isArray(value)) {
      out[name] = value.map(scalar).filter((x): x is Scalar => x !== undefined);
      continue;
    }
    const s: ContextValue | undefined = value === null ? null : scalar(value);
    if (s !== undefined) out[name] = s;
  }
  return out;
}

function resolution<T>(d: Detail<T>): ResolutionDetails<T> {
  if (d.reason === 'ERROR') {
    const code = d.errorCode ?? 'MALFORMED_FLAG';
    return {
      value: d.value,
      reason: StandardResolutionReasons.ERROR,
      errorCode: ERROR_CODES[code],
      errorMessage: code,
    };
  }
  const r: ResolutionDetails<T> = { value: d.value, reason: d.reason };
  if (d.variant !== undefined) r.variant = d.variant;
  if (d.ruleId !== undefined) r.flagMetadata = { ruleId: d.ruleId };
  return r;
}

/**
 * OpenFeature provider backed by FlagshipClient. Evaluation stays local; the
 * provider adds the context mapping, OpenFeature reasons and error codes,
 * and turns client events into provider events.
 */
export class FlagshipProvider implements Provider {
  readonly metadata = { name: 'flagship' } as const;
  readonly runsOn = 'server' as const;
  readonly events = new OpenFeatureEventEmitter();
  readonly client: FlagshipClient;

  constructor(
    options: ClientOptions | FlagshipClient,
    private readonly readyTimeoutMs = 10_000,
  ) {
    this.client = options instanceof FlagshipClient ? options : new FlagshipClient(options);
    this.client.on('change', (c) => {
      this.events.emit(ProviderEvents.ConfigurationChanged, { flagsChanged: c.flags });
    });
    this.client.on('status', (s) => {
      if (s === 'stale')
        this.events.emit(ProviderEvents.Stale, { message: 'flagship server unreachable' });
      if (s === 'ready') this.events.emit(ProviderEvents.Ready);
    });
  }

  async initialize(): Promise<void> {
    if (!(await this.client.ready(this.readyTimeoutMs))) {
      throw new Error('flagship: no ruleset received before the timeout');
    }
  }

  async onClose(): Promise<void> {
    await this.client.close();
  }

  private detail<T>(
    flagKey: string,
    context: EvaluationContext,
    fallback: T,
    run: (c: Context) => Detail<T>,
  ): ResolutionDetails<T> {
    const ctx = toContext(context);
    if (ctx === undefined) {
      return {
        value: fallback,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.TARGETING_KEY_MISSING,
        errorMessage: `targetingKey is required to evaluate "${flagKey}"`,
      };
    }
    return resolution(run(ctx));
  }

  async resolveBooleanEvaluation(flagKey: string, fallback: boolean, context: EvaluationContext) {
    return this.detail(flagKey, context, fallback, (c) =>
      this.client.boolDetail(flagKey, c, fallback),
    );
  }

  async resolveStringEvaluation(flagKey: string, fallback: string, context: EvaluationContext) {
    return this.detail(flagKey, context, fallback, (c) =>
      this.client.stringDetail(flagKey, c, fallback),
    );
  }

  async resolveNumberEvaluation(flagKey: string, fallback: number, context: EvaluationContext) {
    return this.detail(flagKey, context, fallback, (c) =>
      this.client.numberDetail(flagKey, c, fallback),
    );
  }

  async resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    fallback: T,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<T>> {
    return this.detail(flagKey, context, fallback, (c) => {
      const d = this.client.jsonDetail<Flag['variants'][number]['value']>(flagKey, c, null);
      if (d.reason === 'ERROR') return { ...d, value: fallback };
      if (typeof d.value !== 'object' || d.value === null) {
        return { value: fallback, reason: 'ERROR', errorCode: 'TYPE_MISMATCH' };
      }
      return d as Detail<T>;
    });
  }
}

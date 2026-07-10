import { normalizeProductState } from "./storage";
import type { ProductState } from "./types";

// F-05 离线本地分叉的重连/合并支持。
//
// 背景：前端在后端不可用时会继续在 localStorage 里累积本地修改（离线分叉），
// 但此前没有任何"重连后同步"机制——mount 时 getState() 成功会无条件整体采纳
// 远端旧状态，静默覆盖离线期间的本地修改；且 UI 文案承诺"稍后可同步/自动重试"
// 与实现不符。本模块现在提供完整的本地同步地基：
//   1. 持久 outbox 保存 base/local 两份状态与未决冲突，跨刷新存活；
//   2. mergeProductStates 按字段/实体做 base-local-remote 三方合并；
//   3. reconcileOfflineOutbox 保证未决冲突不会在重开后被误当成已解决；
//   4. autosave/重连共用有界指数退避 nextBackoffMs。
// 纯函数与副作用 helper 分离，决策矩阵可被 vitest 直接钉住。

// 与 storage.ts 的 STORAGE_KEY（interview-product-state-v1）保持同一命名族，
// 便于在 DevTools 里一眼看全本产品的 localStorage 足迹。
const UNSYNCED_FLAG_KEY = "interview-product-unsynced-v1";
const UNSYNCED_BACKUP_KEY = "interview-product-unsynced-backup-v1";
const OFFLINE_OUTBOX_KEY = "interview-product-offline-outbox-v1";

export interface OfflineSyncConflict {
  path: string;
  base: unknown;
  local: unknown;
  remote: unknown;
}

/**
 * 持久离线 outbox。它保存最近一次已知服务端基线和最新本地态，而不是只存一个布尔标志：
 * 重连时必须有 base/local/remote 三份状态才能区分“单边修改”与“真正冲突”。
 */
export interface OfflineOutbox {
  version: 1;
  baseRevision: number;
  baseState: ProductState;
  localState: ProductState;
  createdAt: string;
  updatedAt: string;
  conflicts?: OfflineSyncConflict[];
}

export interface ProductStateMergeResult {
  state: ProductState;
  conflicts: OfflineSyncConflict[];
}

export interface OfflineOutboxReconciliation extends ProductStateMergeResult {
  status: "ready" | "conflict";
}

const MISSING = Symbol("offline-sync-missing");
type MaybeMissing = unknown | typeof MISSING;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function equalValue(a: MaybeMissing, b: MaybeMissing): boolean {
  if (a === MISSING || b === MISSING) {
    return a === b;
  }
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function visibleValue(value: MaybeMissing): unknown {
  return value === MISSING ? undefined : value;
}

function childPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function isIdentifiedArray(values: MaybeMissing[]): values is Array<Array<Record<string, unknown> & { id: string }>> {
  if (!values.every(Array.isArray)) {
    return false;
  }
  const entries = (values as unknown[][]).flat();
  return entries.length > 0 && entries.every((entry) => isRecord(entry) && typeof entry.id === "string");
}

function mergeIdentifiedArrays(
  base: Array<Record<string, unknown> & { id: string }>,
  local: Array<Record<string, unknown> & { id: string }>,
  remote: Array<Record<string, unknown> & { id: string }>,
  path: string
): { value: unknown[]; conflicts: OfflineSyncConflict[] } {
  const baseById = new Map(base.map((entry) => [entry.id, entry]));
  const localById = new Map(local.map((entry) => [entry.id, entry]));
  const remoteById = new Map(remote.map((entry) => [entry.id, entry]));
  // 本地顺序优先，远端新增实体随后补入。这样离线端刚插入到数组头部的日志/资产不会
  // 因 normalize 的滚动窗口在合并后被挤到末尾并立即裁掉。
  const ids = [...local.map((entry) => entry.id), ...remote.map((entry) => entry.id)]
    .filter((id, index, all) => all.indexOf(id) === index);
  const value: unknown[] = [];
  const conflicts: OfflineSyncConflict[] = [];

  for (const id of ids) {
    const merged = mergeValue(
      baseById.get(id) ?? MISSING,
      localById.get(id) ?? MISSING,
      remoteById.get(id) ?? MISSING,
      `${path}[${id}]`
    );
    conflicts.push(...merged.conflicts);
    if (merged.value !== MISSING) {
      value.push(merged.value);
    }
  }
  return { value, conflicts };
}

function mergeValue(
  base: MaybeMissing,
  local: MaybeMissing,
  remote: MaybeMissing,
  path: string
): { value: MaybeMissing; conflicts: OfflineSyncConflict[] } {
  if (equalValue(local, base)) {
    return { value: remote, conflicts: [] };
  }
  if (equalValue(remote, base)) {
    return { value: local, conflicts: [] };
  }
  if (equalValue(local, remote)) {
    return { value: local, conflicts: [] };
  }

  if (isIdentifiedArray([base, local, remote])) {
    const [baseItems, localItems, remoteItems] = [base, local, remote] as Array<
      Array<Record<string, unknown> & { id: string }>
    >;
    return mergeIdentifiedArrays(baseItems!, localItems!, remoteItems!, path);
  }

  if (isRecord(base) && isRecord(local) && isRecord(remote)) {
    const keys = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])];
    const value: Record<string, unknown> = {};
    const conflicts: OfflineSyncConflict[] = [];
    for (const key of keys) {
      const merged = mergeValue(
        Object.prototype.hasOwnProperty.call(base, key) ? base[key] : MISSING,
        Object.prototype.hasOwnProperty.call(local, key) ? local[key] : MISSING,
        Object.prototype.hasOwnProperty.call(remote, key) ? remote[key] : MISSING,
        childPath(path, key)
      );
      conflicts.push(...merged.conflicts);
      if (merged.value !== MISSING) {
        value[key] = merged.value;
      }
    }
    return { value, conflicts };
  }

  // 两端都改了同一原子值（或删除/修改同一实体）。合并结果暂以本地值承载，供 UI
  // 继续展示离线工作；但 conflicts 非空时调用方绝不能自动 PUT，必须让用户显式选边。
  return {
    value: local,
    conflicts: [{ path, base: visibleValue(base), local: visibleValue(local), remote: visibleValue(remote) }]
  };
}

/**
 * 对 ProductState 做 base/local/remote 三方合并：
 * - 单边变化自动保留；
 * - 带 id 的实体数组按实体合并；
 * - 同一叶子双端异值记录冲突，绝不允许调用方静默覆盖；
 * - revision/schemaVersion 始终服从当前服务端。
 */
export function mergeProductStates(base: ProductState, local: ProductState, remote: ProductState): ProductStateMergeResult {
  const stripStorageMeta = (state: ProductState): Record<string, unknown> => {
    const record = { ...state } as unknown as Record<string, unknown>;
    delete record.revision;
    delete record.schemaVersion;
    return record;
  };
  const merged = mergeValue(stripStorageMeta(base), stripStorageMeta(local), stripStorageMeta(remote), "");
  const content = merged.value === MISSING || !isRecord(merged.value) ? stripStorageMeta(local) : merged.value;
  const state = normalizeProductState({
    ...content,
    revision: remote.revision,
    schemaVersion: remote.schemaVersion
  });
  return { state, conflicts: merged.conflicts };
}

function conflictIdentity(conflict: OfflineSyncConflict): string {
  return JSON.stringify(canonicalize(conflict));
}

/**
 * 将持久 outbox 与当前远端态重放。outbox.conflicts 表示用户尚未裁决的历史冲突：
 * 即便本轮三方比较不再产出新冲突，也必须继续阻断自动 PUT，直到用户显式选边。
 */
export function reconcileOfflineOutbox(outbox: OfflineOutbox, remote: ProductState): OfflineOutboxReconciliation {
  const merged = mergeProductStates(outbox.baseState, outbox.localState, remote);
  const conflicts = [...(outbox.conflicts ?? []), ...merged.conflicts].filter(
    (conflict, index, all) => all.findIndex((candidate) => conflictIdentity(candidate) === conflictIdentity(conflict)) === index
  );
  return {
    state: merged.state,
    conflicts,
    status: conflicts.length > 0 ? "conflict" : "ready"
  };
}

/** 创建或刷新 outbox；existing 存在时绝不漂移原始服务端基线。 */
export function upsertOfflineOutbox(input: {
  existing?: OfflineOutbox | null;
  baseState: ProductState;
  localState: ProductState;
  conflicts?: OfflineSyncConflict[];
  now?: string;
}): OfflineOutbox {
  const now = input.now ?? new Date().toISOString();
  const existing = input.existing ?? undefined;
  const baseState = existing?.baseState ?? normalizeProductState(input.baseState);
  const conflicts = input.conflicts ?? existing?.conflicts;
  return {
    version: 1,
    baseRevision: existing?.baseRevision ?? baseState.revision,
    baseState,
    localState: normalizeProductState(input.localState),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(conflicts && conflicts.length > 0 ? { conflicts } : {})
  };
}

export function readOfflineOutbox(): OfflineOutbox | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(OFFLINE_OUTBOX_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<OfflineOutbox>;
    if (parsed.version !== 1 || !parsed.baseState || !parsed.localState) {
      return null;
    }
    return {
      version: 1,
      baseRevision: typeof parsed.baseRevision === "number" ? parsed.baseRevision : parsed.baseState.revision,
      baseState: normalizeProductState(parsed.baseState),
      localState: normalizeProductState(parsed.localState),
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      ...(Array.isArray(parsed.conflicts) ? { conflicts: parsed.conflicts } : {})
    };
  } catch {
    return null;
  }
}

export function writeOfflineOutbox(outbox: OfflineOutbox): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    window.localStorage.setItem(OFFLINE_OUTBOX_KEY, JSON.stringify(outbox));
    // 兼容已发布的 v1 标志：outbox 是新权威，但继续置位旧键，让旧前端也不会误覆盖。
    window.localStorage.setItem(UNSYNCED_FLAG_KEY, outbox.updatedAt);
    return true;
  } catch {
    return false;
  }
}

export function clearOfflineOutbox(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(OFFLINE_OUTBOX_KEY);
    window.localStorage.removeItem(UNSYNCED_FLAG_KEY);
  } catch {
    // 与已有 storage helper 同口径：清理失败最多导致下一次再执行一次同步决策。
  }
}

/** 是否存在离线期间尚未同步到服务端的本地修改。 */
export function hasUnsyncedLocalChanges(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(UNSYNCED_FLAG_KEY) !== null;
  } catch {
    return false;
  }
}

/** 置位未同步标志（存时间戳便于人工排查"从什么时候开始没同步"）。 */
export function markUnsyncedLocalChanges(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(UNSYNCED_FLAG_KEY, new Date().toISOString());
  } catch {
    // 隐私模式 / 配额超限：标志写不进去只影响重连保护的触发，绝不能炸掉保存流程。
  }
}

/** 清除未同步标志（本地内容已确认写入服务端时调用）。 */
export function clearUnsyncedLocalChanges(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(UNSYNCED_FLAG_KEY);
  } catch {
    // 同上：失败静默，最多导致下次多做一次无害的"内容相同→清标志"。
  }
}

/**
 * 把即将被服务端版本覆盖的本地状态存一份备份。
 * 这是最后防线：离线修改推送冲突/失败而不得不采纳服务端版本时，本地态不至于
 * 彻底丢失（用户可从 DevTools 手动取回）。刻意不做 UI 恢复入口——单用户产品里
 * 这种双重冲突极罕见，为它建 UI 的复杂度不划算。
 */
export function backupUnsyncedState(state: unknown): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      UNSYNCED_BACKUP_KEY,
      JSON.stringify({ backedUpAt: new Date().toISOString(), state })
    );
  } catch {
    // 备份失败（配额）也不能阻断重连流程；标志/notice 已经把"发生过覆盖"告知用户。
  }
}

export type InitialSyncDecision = "adopt-remote" | "push-local" | "adopt-remote-clear-flag";

/**
 * mount 初始 getState() 成功后的同步决策（F-05 重连保护核心矩阵）：
 * - 无未同步标志 → 采纳远端（现行为，服务器是真相源）；
 * - 有标志且本地内容 ≠ 远端 → 本地优先推送（离线修改是单用户产品下用户的最新意图）；
 * - 有标志但内容相同 → 采纳远端并清标志（上次会话其实已同步成功，只是标志没来得及清）。
 * 签名比较用 productStateContentSignature（忽略 revision），revision 漂移不算内容分歧。
 */
export function decideInitialSync(input: {
  hasUnsynced: boolean;
  localSignature: string;
  remoteSignature: string;
}): InitialSyncDecision {
  if (!input.hasUnsynced) {
    return "adopt-remote";
  }
  if (input.localSignature !== input.remoteSignature) {
    return "push-local";
  }
  return "adopt-remote-clear-flag";
}

// autosave 失败重试退避参数：5s 起步（网络抖动通常几秒内恢复），指数放大避免
// 后端宕机时高频轰炸，封顶 60s 保证"后端恢复后最多一分钟内自动追上"。
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 60_000;

/**
 * 第 consecutiveFailures 次连续失败后的重试等待时长（有界指数退避）：
 * 1→5s, 2→10s, 3→20s, 4→40s, 5+→60s。非法输入（<1）按 1 处理。
 */
export function nextBackoffMs(consecutiveFailures: number): number {
  const n = Math.max(1, Math.floor(consecutiveFailures));
  // 2^(n-1) 在 n 很大时会溢出为 Infinity，先夹住指数再算。
  const exponent = Math.min(n - 1, 10);
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_CAP_MS);
}

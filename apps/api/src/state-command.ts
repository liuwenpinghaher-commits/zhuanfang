import type { ProductState } from "../../../src/domain/types";
import {
  GovernanceInFlightError,
  StateRevisionConflictError,
  type ProductStateRepository
} from "./product-state-repository";
import type { WriteGate } from "./server";

/**
 * R3(SurrealDB 最优化重构 §4):热点写路由的换轨骨架——应用层 CAS 重试命令。
 *
 * 形状:getState() → mutate(纯函数,基于最新快照重算) → replaceState(next, {expectedRevision})。
 * 撞 StateRevisionConflictError(并发写抢先 bump 了 revision)→ 重读最新态、重新执行 mutate、重试,
 * 有界(默认 3 次重试);撞 GovernanceInFlightError(治理事务在途)→ 直接上抛(statusCode=409,
 * 全局 setErrorHandler 自动映射,前端已有 409 处理);重试耗尽 → 把最后一次冲突错误标上
 * statusCode=409 后如实上抛(不掩盖为成功,不静默 last-write-wins)。
 *
 * ── 为什么 commit 仍要经 writeGate.runExclusive(D3 反向 clobber 不变量)────────────────
 * 遗留长路由(/turns、/end、consolidate、candidates approve、podcast、chat、corpus、import…)
 * 的形状是「读整态 → await 慢 IO(LLM/embedding,可达 330s)→ 整态 replaceState(无
 * expectedRevision)」,靠"整个请求期间持有全局写 slot"保证读写窗口独占。被豁免出全局写锁的
 * 路由若把终写裸落在这样一个在途窗口中间,长路由的最终整态写会把它无声回滚(反向 clobber——
 * 本仓库已为此付过三轮学费:D3 / R3-A / R3-B)。因此 R3 的豁免语义与 auto-run(D3)、
 * PATCH 记忆记录(R6-6)完全一致:**豁免的是"handler 期间不整段持锁",不是"终写绕过串行化"**——
 * 每次 CAS 尝试(读-算-写连续同步块)经写门排队,与在途长持锁写互斥;等后续阶段把遗留长路由
 * 也换成"重读 latest+合并/CAS"后,写门对这些命令路由自然退化为 no-op,届时移除 writeGate
 * 参数即可,本 helper 与各试点路由零改动(CAS 独立扛正确性)。
 *
 * ── 丢失更新为何不可能 ─────────────────────────────────────────────────────────────
 * 单次尝试(getState → mutate → replaceState)是**无 await 的连续同步块**:JS 单线程下原子执行,
 * 进程内没有任何代码能插进我们的读写之间;写门再保证这个同步块不落进他人"读了但还没写"的
 * 窗口。两者合起来:每个写方的读写窗口互斥 ⇒ 无静默交叠。expectedRevision 是纵深防御——
 * 若未来出现绕开写门的写方,冲突会变成响亮的重试/409,绝不会变成静默丢写。
 *
 * ── 审计同事务 ────────────────────────────────────────────────────────────────────
 * 审计事件本就活在 ProductState 的数组里(域层 withAuditEvent 把它并进同一个 next),与业务
 * 变更走同一次 replaceState = 同一次 persist diff = 同一个 DB 事务,"审计与业务同事务"自动成立,
 * 无需任何额外机器。
 *
 * ── mutate 契约 ──────────────────────────────────────────────────────────────────
 * 1. 必须是同步纯函数:**临界区内绝不允许 await 外部 IO**(embedding/LLM 先在调用方算好,把
 *    结果以闭包常量的形式带进 mutate,如 PATCH /api/memory-records 的 reembedded)。
 * 2. 每次重试都会拿到【最新】state 重新调用:mutate 里做的实体查找/状态校验天然是"以最新为准",
 *    调用方若用闭包变量向外带上下文(找到的实体/失败原因),须在 mutate 开头清零上一轮残留。
 * 3. 返回 null 表示 no-op(实体不存在/状态不满足前置条件等),本 helper 不写库、原样返回 null,
 *    由调用方决定 404/409/422 语义。
 */
export interface StateCommandOptions {
  /**
   * CAS 冲突后的最大重试次数(不含首次尝试),默认 3。
   * 为什么是 3:冲突只发生在"另一写方在本命令的读→写微秒级同步窗口内也提交了一笔"。命令 commit
   * 是门内连续同步块(无 await),同一时刻至多一个写方在推进,冲突源只能是"上一个刚释放门的写方
   * 恰好 bump 了 revision"——每次重试都读到全新基线,连撞 N 次的概率随 N 指数衰减到可忽略。3 次给
   * 足退让空间又保证有界(耗尽即响亮 409,不无限自旋)。负值被下方 Math.max(0,…) 钳到 0(至少跑一次)。
   */
  maxRetries?: number;
  /**
   * 全局写门(server.ts registerWriteSerialization 的返回值)。被豁免出 preHandler 写锁的路由
   * **必须**传入——见文件头"D3 反向 clobber 不变量"。不传则裸执行(仅限测试/本就持锁的调用方)。
   */
  writeGate?: WriteGate;
  /** 写门持锁者点名标签(写路径卡死时日志直接指认凶手);建议 `command:<路由>:<实体id>`。 */
  label?: string;
}

export async function runStateCommand(
  repo: ProductStateRepository,
  mutate: (state: ProductState) => ProductState | null,
  opts: StateCommandOptions = {}
): Promise<ProductState | null> {
  // M4:钳负值——maxRetries<0 会让循环一次不跑,lastConflict 恒 undefined,耗尽分支解引用即 NPE。
  const maxRetries = Math.max(0, opts.maxRetries ?? 3);
  const label = opts.label ?? "state-command";
  let lastConflict: StateRevisionConflictError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 单次尝试:读-算-写连续同步块(原子,见文件头论证)。每次重试从最新态整体重来。
    const attemptOnce = (): ProductState | null => {
      const state = repo.getState();
      const next = mutate(state);
      if (next === null) {
        return null; // no-op:不写库,由调用方决定 404 等语义
      }
      return repo.replaceState(next, { expectedRevision: state.revision ?? 0 });
    };
    try {
      return opts.writeGate ? await opts.writeGate.runExclusive(label, attemptOnce) : attemptOnce();
    } catch (err) {
      if (err instanceof GovernanceInFlightError) {
        // 治理事务(reset/purge/import)在途:重试只会再次撞上,直接上抛。
        // GovernanceInFlightError.statusCode=409 → 全局 setErrorHandler 自动映射 409。
        throw err;
      }
      if (err instanceof StateRevisionConflictError) {
        lastConflict = err;
        continue; // 重读最新态、重算、重试(有界)
      }
      throw err; // 其它错误(域层不变量/持久层故障)原样冒泡,不吞
    }
  }
  // 重试耗尽:原样上抛 StateRevisionConflictError(message 携 expected/actual revision)。
  // M2:映射 409 的职责下沉到全局 setErrorHandler(server.ts:`instanceof StateRevisionConflictError → 409`)——
  // 无需 per-throw 在实例上打 statusCode。全局 handler 只兜未捕获错误;PUT /api/state 手动预检 revision、
  // replaceState 不传 expectedRevision,永不抛该类,天然不经此路径,不受影响。
  throw lastConflict!;
}

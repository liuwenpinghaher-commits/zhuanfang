import { ChevronRight, ClipboardList, History, Play, Sparkles, Target, TimerReset } from "lucide-react";
import { HeaderBlock } from "../../components/HeaderBlock";
import { Metric } from "../../components/Metric";
import type { buildInterviewCard, buildMonthlyReview } from "../../domain/engine";
import type { InterviewMode, ProductState } from "../../domain/types";

const modeOptions: Array<{ id: InterviewMode; label: string; detail: string }> = [
  { id: "daily", label: "日常复盘", detail: "把事件推进到机制和模式" },
  { id: "decision", label: "决策专访", detail: "拆选项、代价、假设和复盘点" },
  { id: "point", label: "观点专访", detail: "找前提、反例和适用边界" },
  { id: "learning", label: "学习专访", detail: "把输入知识变成自己的理解" },
  { id: "organization", label: "组织/关系", detail: "看见角色、权力和隐性规则" },
  { id: "long-term", label: "长期主题", detail: "回访一个反复出现的问题" }
];

interface HomeViewProps {
  state: ProductState;
  card: ReturnType<typeof buildInterviewCard>;
  monthlyReview: ReturnType<typeof buildMonthlyReview>;
  onStart: (mode?: InterviewMode) => void;
}

export function HomeView({ state, card, monthlyReview, onStart }: HomeViewProps) {
  const openDebt = state.debts.find((debt) => debt.status === "待了解") ?? state.debts[0];
  const topTheme = state.themes[0];

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="今日访谈台"
        title={card.title}
        subtitle="系统已根据长期主题、知识债和历史原话准备本次专访方向。"
        action={<button className="primary-action" type="button" onClick={() => onStart("decision")}><Play size={18} />开始聊这个</button>}
      />

      <div className="dashboard-grid">
        <section className="panel span-2">
          <div className="panel-title">
            <Sparkles size={18} />
            <h2>今日主建议</h2>
          </div>
          <p className="lead">{card.whyNow}</p>
          {card.historyReferences[0] && (
            <div className="quote-line">&ldquo;{card.historyReferences[0]}&rdquo;</div>
          )}
          <div className="inline-list">
            {card.suggestedPerspectives.map((perspective) => (
              <span key={perspective}>{perspective}</span>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <TimerReset size={18} />
            <h2>继续追踪</h2>
          </div>
          {topTheme ? (
            <>
              <p>{topTheme.nextQuestion}</p>
              <button className="text-button" type="button" onClick={() => onStart("long-term")}>继续长期主题 <ChevronRight size={16} /></button>
            </>
          ) : (
            <p className="empty-hint">还没有长期主题，开始第一次专访后会自动出现在这里。</p>
          )}
        </section>

        <section className="panel">
          <div className="panel-title">
            <ClipboardList size={18} />
            <h2>知识债</h2>
          </div>
          {openDebt ? (
            <>
              <p>{openDebt.concept}</p>
              <small>{openDebt.nextQuestion}</small>
            </>
          ) : (
            <p className="empty-hint">还没有知识债，专访中会自动识别并记录。</p>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-title">
          <Target size={18} />
          <h2>选择访谈模式</h2>
        </div>
        <div className="mode-grid">
          {modeOptions.map((mode) => (
            <button className="mode-option" key={mode.id} type="button" onClick={() => onStart(mode.id)}>
              <strong>{mode.label}</strong>
              <span>{mode.detail}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">
          <History size={18} />
          <h2>本月信号</h2>
        </div>
        <div className="metric-row">
          <Metric label="笔记" value={monthlyReview.metrics.notes} />
          <Metric label="观点" value={monthlyReview.metrics.points} />
          <Metric label="问题" value={monthlyReview.metrics.questions} />
          <Metric label="知识债" value={monthlyReview.metrics.knowledgeDebts} />
          <Metric label="长期主题" value={monthlyReview.metrics.themes} />
        </div>
      </section>
    </section>
  );
}

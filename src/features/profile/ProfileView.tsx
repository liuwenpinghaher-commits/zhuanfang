import { Brain, PenLine, Settings, ShieldCheck, Trash2 } from "lucide-react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { ProductState } from "../../domain/types";

interface ProfileViewProps {
  state: ProductState;
  correctionText: string;
  onCorrectionText: (value: string) => void;
  onAddCorrection: () => void;
  onReset: () => void;
}

export function ProfileView({ state, correctionText, onCorrectionText, onAddCorrection, onReset }: ProfileViewProps) {
  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="个人档案与控制"
        title={`${state.profile.role} · ${state.profile.industry}`}
        subtitle="长期记忆必须可见、可修正、可删除。AI 推断不能直接等同于事实。"
      />
      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-title"><Settings size={18} /><h2>显性档案</h2></div>
          <dl className="detail-list">
            <dt>当前关注</dt>
            <dd>{state.profile.currentFocus}</dd>
            <dt>长期目标</dt>
            <dd>{state.profile.longTermGoal}</dd>
            <dt>追问强度</dt>
            <dd>{state.profile.preferredStrength}</dd>
          </dl>
        </section>
        <section className="panel">
          <div className="panel-title"><ShieldCheck size={18} /><h2>用户边界</h2></div>
          <ul className="clean-list">
            {state.profile.explicitBoundaries.map((boundary) => <li key={boundary}>{boundary}</li>)}
          </ul>
        </section>
      </div>

      <section className="panel">
        <div className="panel-title"><Brain size={18} /><h2>系统记忆</h2></div>
        <div className="memory-grid">
          <div>
            <span className="label">用户确认</span>
            <ul>{state.profile.confirmedMemories.map((memory) => <li key={memory}>{memory}</li>)}</ul>
          </div>
          <div>
            <span className="label">AI 推断</span>
            <ul>{state.profile.inferredMemories.map((memory) => <li key={memory}>{memory}</li>)}</ul>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title"><PenLine size={18} /><h2>修正 AI 理解</h2></div>
        <div className="correction-row">
          <label className="field-stack" htmlFor="memory-correction">
            <span className="field-label">修正说明</span>
            <input
              id="memory-correction"
              value={correctionText}
              onChange={(event) => onCorrectionText(event.target.value)}
              placeholder="例：不要把我对项目的不满写成对团队成员的否定。"
            />
            <span className="field-help">这会作为长期边界保留，不会直接覆盖用户确认记忆。</span>
          </label>
          <button className="primary-action" type="button" onClick={onAddCorrection}>保存修正</button>
        </div>
        {state.memoryCorrections.length > 0 && (
          <ul className="clean-list">
            {state.memoryCorrections.map((correction) => <li key={correction.id}>{correction.text}</li>)}
          </ul>
        )}
      </section>

      <section className="danger-zone">
        <div>
          <strong>重置演示数据</strong>
          <p>清空本地状态并恢复初始业务样例。</p>
        </div>
        <button className="danger-button" type="button" onClick={onReset}><Trash2 size={17} />重置</button>
      </section>
    </section>
  );
}

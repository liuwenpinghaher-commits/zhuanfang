import { useState } from "react";
import { Bookmark, Play, Plus, Trash2, X } from "lucide-react";
import { HeaderBlock } from "../../components/HeaderBlock";
import type { IntelItem, ProductState } from "../../domain/types";

interface IntelViewProps {
  state: ProductState;
  runningTaskId: string | null;
  onCreate: (name: string, keywords: string[]) => void;
  onRun: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onItemStatus: (itemId: string, status: IntelItem["status"]) => void;
  onToDebt: (itemId: string) => void;
}

export function IntelView({
  state,
  runningTaskId,
  onCreate,
  onRun,
  onDeleteTask,
  onItemStatus,
  onToDebt
}: IntelViewProps) {
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState("");

  const feed = state.intelItems
    .filter((item) => item.status !== "ignored")
    .sort((a, b) => b.relevance - a.relevance);

  function handleCreate() {
    const parsed = keywords.split(/[,，、\s]+/).map((keyword) => keyword.trim()).filter(Boolean);
    if (parsed.length === 0) return;
    onCreate(name.trim() || "未命名情报任务", parsed);
    setName("");
    setKeywords("");
  }

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="情报中心"
        title="自动化情报任务"
        subtitle="定义你想持续关注的主题，系统联网搜集并分诊成情报流，可一键带入专访或转成知识债。"
      />

      <article className="record-row">
        <div className="record-main">
          <label className="label" htmlFor="intel-name">任务名称</label>
          <input id="intel-name" type="text" value={name} placeholder="例如：AI 编程 agent 监控" onChange={(event) => setName(event.target.value)} />
          <label className="label" htmlFor="intel-keywords">关键词（逗号或空格分隔）</label>
          <input id="intel-keywords" type="text" value={keywords} placeholder="AI 编程 agent, coding agent 落地" onChange={(event) => setKeywords(event.target.value)} />
          <p className="label" style={{ marginTop: "0.5rem", opacity: 0.7 }}>
            自动运行需保持 API 服务在线（关闭后暂停）。
          </p>
          <div className="note-actions">
            <button className="primary-action" type="button" disabled={!keywords.trim()} onClick={handleCreate}>
              <Plus size={16} />创建情报任务
            </button>
          </div>
        </div>
      </article>

      <div className="record-list">
        <h2>监控任务（{state.intelTasks.length}）</h2>
        {state.intelTasks.length === 0 && <p className="label">还没有情报任务。创建一个开始持续监控。</p>}
        {state.intelTasks.map((task) => (
          <article className="record-row" key={task.id}>
            <div className="record-main">
              <span className="label">
                {task.keywords.join("、")} · provider {task.provider}
                {task.lastRunAt ? ` · 上次运行 ${new Date(task.lastRunAt).toLocaleString("zh-CN")}` : " · 尚未运行"}
              </span>
              <h2>{task.name}</h2>
            </div>
            <div className="note-actions">
              <button className="primary-action" type="button" disabled={runningTaskId === task.id} onClick={() => onRun(task.id)}>
                <Play size={16} />{runningTaskId === task.id ? "抓取中…" : "立即运行"}
              </button>
              <button className="secondary-action" type="button" onClick={() => onDeleteTask(task.id)}>
                <Trash2 size={16} />删除
              </button>
            </div>
          </article>
        ))}
      </div>

      <div className="record-list">
        <h2>情报流（{feed.length}）</h2>
        {feed.length === 0 && <p className="label">运行一个任务后，分诊过的情报会出现在这里。</p>}
        {feed.map((item) => (
          <article className="record-row" key={item.id}>
            <div className="record-main">
              <span className="label">
                {item.category} · 相关度 {item.relevance} · {item.taskName}
                {item.status === "saved" ? " · ⭐ 已保存" : ""}
              </span>
              <h2>{item.title}</h2>
              <p>{item.summary}</p>
              {item.claims.length > 0 && (
                <ul>{item.claims.slice(0, 3).map((claim) => <li key={claim}>{claim}</li>)}</ul>
              )}
              <a className="quote-line" href={item.url} target="_blank" rel="noreferrer">{item.url}</a>
            </div>
            <div className="note-actions">
              <button className="secondary-action" type="button" onClick={() => onToDebt(item.id)}>
                转知识债
              </button>
              <button className="secondary-action" type="button" onClick={() => onItemStatus(item.id, "saved")}>
                <Bookmark size={16} />保存
              </button>
              <button className="secondary-action" type="button" onClick={() => onItemStatus(item.id, "ignored")}>
                <X size={16} />忽略
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

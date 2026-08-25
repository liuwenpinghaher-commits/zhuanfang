import { Archive, BookOpen, FileText } from "lucide-react";
import type { ReactNode } from "react";
import { HeaderBlock } from "../../components/HeaderBlock";

export type SessionRecordPane = "notes" | "archive" | "assets";

interface SessionRecordViewProps {
  pane: SessionRecordPane;
  onPane: (pane: SessionRecordPane) => void;
  children: ReactNode;
}

const PANES: Array<{ id: SessionRecordPane; label: string; Icon: typeof BookOpen }> = [
  { id: "notes", label: "笔记", Icon: BookOpen },
  { id: "archive", label: "本场档案", Icon: FileText },
  { id: "assets", label: "本场资产", Icon: Archive }
];

export function SessionRecordView({ pane, onPane, children }: SessionRecordViewProps) {
  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="双轨笔记"
        title="本场记录"
        subtitle="这里就是以前的双轨笔记。读这一场、看本场产出，再改观点、问题和决策。"
      />
      <nav className="seg-tabs" aria-label="本场记录分段">
        {PANES.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className={pane === id ? "seg-tab active" : "seg-tab"}
            data-testid={`session-record-tab-${id}`}
            onClick={() => onPane(id)}
            aria-current={pane === id ? "true" : undefined}
          >
            <Icon size={16} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      {children}
    </section>
  );
}

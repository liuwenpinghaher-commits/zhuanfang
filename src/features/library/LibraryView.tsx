import { Library, MessagesSquare } from "lucide-react";
import type { ReactNode } from "react";
import { HeaderBlock } from "../../components/HeaderBlock";

export type LibraryPane = "chat" | "import";

interface LibraryViewProps {
  pane: LibraryPane;
  onPane: (pane: LibraryPane) => void;
  children: ReactNode;
}

export function LibraryView({ pane, onPane, children }: LibraryViewProps) {
  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="资料"
        title="放进我的书，或问我的书"
        subtitle="问全书走资产对话；导入与索引仍是原料车间。「只问这份」在导入页里，不是第二个一级入口。"
      />
      <nav className="seg-tabs" aria-label="资料分段">
        <button
          type="button"
          className={pane === "chat" ? "seg-tab active" : "seg-tab"}
          onClick={() => onPane("chat")}
          aria-current={pane === "chat" ? "true" : undefined}
        >
          <MessagesSquare size={16} aria-hidden="true" />
          <span>问全书</span>
        </button>
        <button
          type="button"
          className={pane === "import" ? "seg-tab active" : "seg-tab"}
          onClick={() => onPane("import")}
          aria-current={pane === "import" ? "true" : undefined}
        >
          <Library size={16} aria-hidden="true" />
          <span>导入与索引</span>
        </button>
      </nav>
      {children}
    </section>
  );
}

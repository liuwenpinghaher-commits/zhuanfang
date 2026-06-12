import type { ReactNode } from "react";

interface HeaderBlockProps {
  eyebrow: string;
  title: string;
  subtitle: string;
  action?: ReactNode;
}

export function HeaderBlock({ eyebrow, title, subtitle, action }: HeaderBlockProps) {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </header>
  );
}

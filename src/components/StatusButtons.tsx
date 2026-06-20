interface StatusButtonsProps {
  label?: string;
  options: string[];
  onSelect: (status: string) => void;
  /** Currently-applied status — rendered as the active/selected option. */
  active?: string;
}

export function StatusButtons({ label, options, onSelect, active }: StatusButtonsProps) {
  return (
    <div className="status-actions">
      {label && <span className="field-label">{label}</span>}
      {options.map((option) => {
        const isActive = option === active;
        return (
          <button
            type="button"
            key={option}
            className={isActive ? "active" : undefined}
            aria-pressed={isActive}
            disabled={isActive}
            onClick={() => onSelect(option)}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

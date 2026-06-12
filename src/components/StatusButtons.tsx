interface StatusButtonsProps {
  label?: string;
  options: string[];
  onSelect: (status: string) => void;
}

export function StatusButtons({ label, options, onSelect }: StatusButtonsProps) {
  return (
    <div className="status-actions">
      {label && <span className="field-label">{label}</span>}
      {options.map((option) => (
        <button type="button" key={option} onClick={() => onSelect(option)}>
          {option}
        </button>
      ))}
    </div>
  );
}

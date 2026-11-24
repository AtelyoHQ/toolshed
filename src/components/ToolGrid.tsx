import { ALL_TOOLS, GROUP_LABELS, type Tool, type ToolGroup } from '../lib/tools';

interface Props {
  selected: string;
  onSelect: (toolId: string) => void;
}

const GROUPS: ToolGroup[] = ['image', 'pdf', 'convert'];

export function ToolGrid({ selected, onSelect }: Props) {
  return (
    <div className="grid gap-5 sm:grid-cols-3">
      {GROUPS.map((group) => (
        <section key={group} aria-labelledby={`group-${group}`}>
          <h2
            id={`group-${group}`}
            className="text-shell-400 mb-2 font-mono text-xs tracking-widest uppercase"
          >
            {GROUP_LABELS[group]}
          </h2>
          <ul className="space-y-1">
            {ALL_TOOLS.filter((tool) => tool.group === group).map((tool) => (
              <li key={tool.id}>
                <ToolButton tool={tool} selected={tool.id === selected} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ToolButton({
  tool,
  selected,
  onSelect,
}: {
  tool: Tool;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const disabled = Boolean(tool.unavailable);

  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={() => onSelect(tool.id)}
      className={`w-full rounded border px-3 py-2 text-left transition-colors ${
        selected
          ? 'border-accent-500 bg-accent-500/10'
          : 'border-shell-200 dark:border-shell-700 hover:bg-shell-100 dark:hover:bg-shell-800'
      } ${disabled ? 'cursor-not-allowed opacity-45 hover:bg-transparent dark:hover:bg-transparent' : ''}`}
    >
      <span className="flex items-baseline gap-2">
        <span className="text-sm font-medium">{tool.label}</span>
        {disabled && <span className="text-shell-400 font-mono text-[10px]">soon</span>}
      </span>
      <span className="text-shell-400 mt-0.5 block text-xs">{tool.summary}</span>
    </button>
  );
}

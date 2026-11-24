import { parseSize } from '../lib/bytes';
import type { SettingField, Tool } from '../lib/tools';
import type { ToolSettings } from '../lib/types';

interface Props {
  tool: Tool;
  settings: ToolSettings;
  onChange: (patch: ToolSettings) => void;
  idPrefix: string;
}

/**
 * Renders a tool's declared settings.
 *
 * Generic on purpose: every control gets the same label association, hint
 * wiring and keyboard behaviour, which is what hand-built panels forget one
 * at a time.
 */
export function SettingsPanel({ tool, settings, onChange, idPrefix }: Props) {
  if (tool.fields.length === 0) {
    return <p className="text-shell-400 text-xs">{tool.note ?? 'Nothing to configure.'}</p>;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {tool.fields.map((field) => (
        <Field
          key={field.key}
          field={field}
          id={`${idPrefix}-${field.key}`}
          value={settings[field.key]}
          onChange={(value) => onChange({ [field.key]: value })}
        />
      ))}
      {tool.note && <p className="text-shell-400 text-[11px] sm:col-span-2">{tool.note}</p>}
    </div>
  );
}

function Field({
  field,
  id,
  value,
  onChange,
}: {
  field: SettingField;
  id: string;
  value: ToolSettings[string] | undefined;
  onChange: (value: string | number | boolean) => void;
}) {
  const hintId = field.hint ? `${id}-hint` : undefined;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium">
          {field.label}
        </label>
        {field.type === 'range' && (
          <span className="text-shell-400 font-mono text-xs">{value}</span>
        )}
      </div>

      {field.type === 'range' && (
        <input
          id={id}
          type="range"
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          value={Number(value ?? field.min)}
          aria-describedby={hintId}
          onChange={(event) => onChange(Number(event.target.value))}
          className="accent-accent-500 mt-1 w-full"
        />
      )}

      {field.type === 'toggle' && (
        <label className="mt-1 flex items-center gap-2 text-xs">
          <input
            id={id}
            type="checkbox"
            checked={value !== false}
            aria-describedby={hintId}
            onChange={(event) => onChange(event.target.checked)}
            className="accent-accent-500"
          />
          <span className="text-shell-400">{value !== false ? 'Yes' : 'No'}</span>
        </label>
      )}

      {field.type === 'size' && (
        <SizeField id={id} value={String(value ?? '')} hintId={hintId} onChange={onChange} />
      )}

      {field.type === 'select' && (
        <select
          id={id}
          value={String(value ?? field.options[0]?.value ?? '')}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.value)}
          className="border-shell-200 dark:border-shell-700 dark:bg-shell-850 mt-1 w-full rounded border px-2 py-1 text-xs"
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}

      {field.hint && (
        <p id={hintId} className="text-shell-400 mt-1 text-[11px]">
          {field.hint}
        </p>
      )}
    </div>
  );
}

function SizeField({
  id,
  value,
  hintId,
  onChange,
}: {
  id: string;
  value: string;
  hintId: string | undefined;
  onChange: (value: string) => void;
}) {
  // Told here rather than at run time, and on the same rule the runner uses:
  // an empty field used to pass this check and then fail the job.
  const valid = parseSize(value) !== null;

  return (
    <>
      <input
        id={id}
        type="text"
        inputMode="text"
        value={value}
        aria-describedby={hintId}
        aria-invalid={!valid}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1 w-full rounded border px-2 py-1 font-mono text-xs ${
          valid
            ? 'border-shell-200 dark:border-shell-700 dark:bg-shell-850'
            : 'border-bad-500 text-bad-500'
        }`}
      />
      {!valid && (
        <p className="text-bad-500 mt-1 text-[11px]">
          {value.trim() === ''
            ? 'Give a size, such as 200kb or 1.5mb.'
            : 'Not a size. Try something like 200kb or 1.5mb.'}
        </p>
      )}
    </>
  );
}

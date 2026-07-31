import { Dropdown } from '@/components/interior/dropdown';

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
}

interface DropdownSelectProps<T extends string> {
  value: T;
  options: ReadonlyArray<DropdownOption<T>>;
  onChange: (v: T) => void;
  ariaLabel: string;
  className?: string;
}

/**
 * Custom (non-native) dropdown with an Apple-HIG flavour: a calm trigger that
 * mirrors {@link Input}'s height/border, a soft floating menu that springs in,
 * and a trailing check on the selected row. Keyboard-driven (arrows / enter /
 * escape) and closes on outside pointer-down. Use when the design wants a menu
 * that matches the surrounding chrome — the plain `Select` stays the zero-dep
 * native fallback for dense forms.
 */
export function DropdownSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: DropdownSelectProps<T>) {
  return (
    <Dropdown
      value={value}
      items={options.map((option) => ({ ...option }))}
      onChange={(next) => onChange(next as T)}
      label={ariaLabel}
      className={className}
    />
  );
}

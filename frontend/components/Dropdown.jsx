'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { trackPointer } from '../lib/liquid.mjs';

const MENU_MAX_HEIGHT = 320;

/**
 * Dropdown Liquid Glass thay cho <select>: menu kính mở có độ nảy, tự lật lên khi thiếu chỗ,
 * hỗ trợ bàn phím (↑ ↓ Home End Enter Space Esc Tab, gõ chữ để nhảy tới mục).
 *
 * @param {string} label
 * @param {any} value
 * @param {{ value: any, label: string, disabled?: boolean }[]} options
 * @param {(value: any) => void} onChange
 * @param {string} [placeholder] hiển thị khi value không khớp option nào
 * @param {boolean} [disabled]
 */
export default function Dropdown({ label, value, options, onChange, placeholder = 'Chọn…', disabled = false, className = '' }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [dropUp, setDropUp] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const list = useRef(null);
  const typeahead = useRef({ text: '', timer: 0 });

  const selectedIndex = options.findIndex(option => option.value === value);
  const selected = options[selectedIndex];
  const enabledIndexes = options.map((option, i) => (option.disabled ? -1 : i)).filter(i => i >= 0);

  function openMenu(index = selectedIndex) {
    if (disabled || !options.length) return;
    setActive(options[index] && !options[index].disabled ? index : enabledIndexes[0] ?? -1);
    setOpen(true);
  }

  function closeMenu(focusTrigger = true) {
    setOpen(false);
    if (focusTrigger) trigger.current?.focus();
  }

  function choose(index) {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    closeMenu();
  }

  function move(step) {
    if (!enabledIndexes.length) return;
    const at = enabledIndexes.indexOf(active);
    const next = at < 0 ? (step > 0 ? 0 : enabledIndexes.length - 1) : Math.min(Math.max(at + step, 0), enabledIndexes.length - 1);
    setActive(enabledIndexes[next]);
  }

  function jumpByText(char) {
    const state = typeahead.current;
    clearTimeout(state.timer);
    state.text += char.toLocaleLowerCase('vi');
    state.timer = setTimeout(() => { state.text = ''; }, 600);
    const start = Math.max(active, 0);
    const order = [...options.keys()].map(i => (i + start + (state.text.length === 1 ? 1 : 0)) % options.length);
    const hit = order.find(i => !options[i].disabled && options[i].label.toLocaleLowerCase('vi').startsWith(state.text));
    if (hit !== undefined) { if (!open) openMenu(hit); else setActive(hit); }
  }

  function onKeyDown(event) {
    const { key } = event;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu(); else move(key === 'ArrowDown' ? 1 : -1);
    } else if (key === 'Home' || key === 'End') {
      if (!open) return;
      event.preventDefault();
      setActive(key === 'Home' ? enabledIndexes[0] : enabledIndexes[enabledIndexes.length - 1]);
    } else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (!open) openMenu(); else choose(active);
    } else if (key === 'Escape') {
      if (open) { event.preventDefault(); closeMenu(); }
    } else if (key === 'Tab') {
      if (open) closeMenu(false);
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      jumpByText(key);
    }
  }

  // Lật menu lên trên nếu phía dưới không đủ chỗ.
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const rect = root.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    setDropUp(below < Math.min(MENU_MAX_HEIGHT, options.length * 46 + 16) && rect.top > below);
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const onDown = event => { if (!root.current?.contains(event.target)) closeMenu(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  useEffect(() => { if (disabled && open) closeMenu(false); }, [disabled, open]);
  useEffect(() => () => clearTimeout(typeahead.current.timer), []);

  const labelId = `${id}-label`;
  const listId = `${id}-list`;
  return <div className={`field ${className}`}>
    <span className="field-label" id={labelId}>{label}</span>
    <div className={`dropdown${open ? ' open' : ''}${dropUp ? ' up' : ''}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className="dropdown-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={`${labelId} ${id}-value`}
        aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onKeyDown}
        onPointerMove={trackPointer}
      >
        <span id={`${id}-value`} className={`dropdown-value${selected ? '' : ' placeholder'}`}>{selected ? selected.label : placeholder}</span>
        <ChevronDown className="icon dropdown-chevron" aria-hidden="true" />
      </button>
      {open && <ul className="dropdown-menu" role="listbox" id={listId} ref={list} aria-labelledby={labelId} tabIndex={-1}>
        {options.map((option, i) => <li
          key={`${String(option.value)}-${i}`}
          id={`${id}-opt-${i}`}
          data-index={i}
          role="option"
          aria-selected={i === selectedIndex}
          aria-disabled={option.disabled || undefined}
          className={`dropdown-option${i === active ? ' active' : ''}${i === selectedIndex ? ' selected' : ''}`}
          style={{ '--i': Math.min(i, 8) }}
          onPointerMove={() => { if (!option.disabled && active !== i) setActive(i); }}
          onPointerDown={event => event.preventDefault()}
          onClick={() => choose(i)}
        >
          <span>{option.label}</span>
          {i === selectedIndex && <Check className="icon" aria-hidden="true" />}
        </li>)}
      </ul>}
    </div>
  </div>;
}

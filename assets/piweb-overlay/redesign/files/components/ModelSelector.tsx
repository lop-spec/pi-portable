"use client";
import { PortableModelList } from "./PortableModelList";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";

export interface ModelSelectorOption {
  provider: string;
  modelId: string;
  name: string;
}

interface ModelSelectorProps {
  options: ModelSelectorOption[];
  value?: { provider: string; modelId: string } | null;
  onChange: (provider: string, modelId: string) => void;
  onClear?: () => void;
  emptyLabel?: string;
  selectedLabel?: string;
  disabled?: boolean;
  busy?: boolean;
  isAutoSelection?: boolean;
  ariaLabel?: string;
  variant?: "toolbar" | "field";
  placement?: "up" | "auto";
}

const MODEL_FILTER_THRESHOLD = 8;
const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelOptions(a: ModelSelectorOption, b: ModelSelectorOption): number {
  return MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId)
    || MODEL_OPTION_COLLATOR.compare(a.provider, b.provider)
    || MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId);
}

export function filterModelOptions(options: ModelSelectorOption[], query: string): ModelSelectorOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;

  return options.filter((option) => (
    `${option.name} ${option.modelId}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  ));
}

/**
 * Toolbar label for a model: the part before " · " (drops "· 网页（ChatGPT）" style suffixes),
 * plus a short "网页" tag when the suffix marks a browser-backed model, so the same base name
 * from a subscription and from a web page stay distinguishable. The full name goes in the tooltip.
 */
export function splitModelName(name: string): { base: string; tag: string } {
  const [base, ...rest] = name.split(/\s+·\s+/);
  const suffix = rest.join(" · ");
  return { base: base.trim() || name, tag: /网页|網頁|web/i.test(suffix) ? "网页" : "" };
}

const ChipIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="pw-model-trigger-icon">
    <rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" />
    <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
  </svg>
);
const Chevron = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="pw-model-trigger-chevron"><path d="m6 9 6 6 6-6" /></svg>
);

export function ModelSelector({
  options,
  value,
  onChange,
  onClear,
  emptyLabel,
  selectedLabel,
  disabled = false,
  busy = false,
  isAutoSelection = false,
  ariaLabel,
  variant = "toolbar",
  placement = "up",
}: ModelSelectorProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<{ top: number; right: number; bottom: number; left: number; width: number } | null>(null);
  const [filter, setFilter] = useState("");
  const locked = disabled || busy;
  const sortedOptions = useMemo(() => [...options].sort(compareModelOptions), [options]);
  const filteredOptions = filterModelOptions(sortedOptions, filter);
  const showFilter = sortedOptions.length > MODEL_FILTER_THRESHOLD;
  const modelsByProvider: { provider: string; options: ModelSelectorOption[] }[] = [];

  for (const option of filteredOptions) {
    const group = modelsByProvider.find((item) => item.provider === option.provider);
    if (group) group.options.push(option);
    else modelsByProvider.push({ provider: option.provider, options: [option] });
  }

  const currentName = selectedLabel ?? (value
    ? sortedOptions.find((option) => option.modelId === value.modelId && option.provider === value.provider)?.name ?? value.modelId
    : emptyLabel ?? (sortedOptions.length > 0 ? t("chat.selectModel") : t("chat.noModels")));
  const currentLabel = t("chat.currentModel", { name: currentName });
  const toolbarName = splitModelName(currentName);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (
        rootRef.current && !rootRef.current.contains(event.target as Node)
        && panelRef.current && !panelRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
        setFilter("");
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  useEffect(() => {
    if (!locked) return;
    setOpen(false);
    setFilter("");
  }, [locked]);

  // The settings form keeps its field look (tested), the composer trigger is styled by .pw-model-trigger.
  const fieldStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 7,
    width: "100%",
    minWidth: 0,
    height: 34,
    padding: "0 9px",
    overflow: "hidden",
    border: "1px solid var(--border)",
    borderRadius: 5,
    background: locked ? "var(--bg-panel)" : "var(--bg)",
    color: locked ? "var(--text-dim)" : "var(--text)",
    cursor: locked ? "default" : "pointer",
    fontSize: 12,
    textAlign: "left",
  };

  const choose = (option: ModelSelectorOption) => {
    const active = option.modelId === value?.modelId && option.provider === value?.provider;
    setOpen(false);
    setFilter("");
    if (!active || isAutoSelection) onChange(option.provider, option.modelId);
  };

  const spinner = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    </svg>
  );

  return (
    <div
      ref={rootRef}
      className={`model-selector is-${variant}${locked ? " is-disabled" : ""}`}
      style={variant === "field" ? { position: "relative", width: "100%", minWidth: 0 } : undefined}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        setFilter("");
        setOpen(false);
      }}
    >
      <button
        type="button"
        className={variant === "toolbar" ? "pw-model-trigger" : undefined}
        aria-label={ariaLabel ?? currentLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-busy={busy || undefined}
        disabled={locked}
        title={busy ? t("chat.switchingModel") : locked ? currentName : sortedOptions.length > 0 || onClear ? currentLabel : t("chat.noAvailableModels")}
        style={variant === "field" ? fieldStyle : undefined}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchorRect({ top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width });
          setOpen((current) => {
            if (current) setFilter("");
            return !current;
          });
        }}
      >
        {variant === "field" ? (
          <>
            {busy ? spinner : <ChipIcon />}
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentName}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </>
        ) : (
          <>
            {busy ? spinner : <ChipIcon />}
            <span className="pw-model-trigger-name">{toolbarName.base}</span>
            {toolbarName.tag && <span className="pw-model-trigger-tag">{toolbarName.tag}</span>}
            <Chevron />
          </>
        )}
      </button>

      {open && anchorRect && (() => {
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
        const spaceAbove = anchorRect.top - 8;
        const spaceBelow = viewportHeight - anchorRect.bottom - 8;
        const openAbove = placement === "up" || spaceAbove > spaceBelow;
        const maxHeight = Math.max(120, Math.min(openAbove ? spaceAbove : spaceBelow, viewportHeight * 0.6));
        const verticalPosition = openAbove
          ? { bottom: viewportHeight - anchorRect.top + 6 }
          : { top: anchorRect.bottom + 6 };
        // Same anchoring as before the redesign: the "更多模型" side panel (placeSidePanel) is tuned against it.
        const horizontalPosition: CSSProperties = isMobile
          ? { left: 8, right: 8, maxWidth: "calc(100vw - 16px)" }
          : { left: anchorRect.left, width: "max-content", minWidth: anchorRect.width, maxWidth: Math.max(anchorRect.width, viewportWidth - anchorRect.left - 8) };

        return (
          <div
            ref={panelRef}
            role="listbox"
            aria-label={ariaLabel ?? currentLabel}
            className={`pw-model-panel${openAbove ? " pw-menu--up" : ""}`}
            style={{
              position: "fixed",
              ...verticalPosition,
              ...horizontalPosition,
              zIndex: 500,
              maxHeight,
            }}
          >
            {value && !filter.trim() && (
              <div className="pw-model-panel-current" title={currentName}>
                <span>当前</span><span className="pw-model-panel-current-name">{currentName}</span>
              </div>
            )}
            {showFilter && (
              <div className="pw-model-panel-filter">
                <input
                  className="pw-input pw-input--sm"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={t("chat.filterModels")}
                  aria-label={t("chat.filterModels")}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}
            <div className="pw-model-panel-list">
              {onClear && !filter.trim() && (
                <ModelOptionButton active={!value} label={emptyLabel ?? "Default"} onClick={() => {
                  setOpen(false);
                  setFilter("");
                  onClear();
                }} />
              )}
              {modelsByProvider.length === 0 ? (
                <div className="pw-model-panel-empty">
                  {filter.trim() ? t("chat.noMatchingModels") : t("chat.noAvailableModels")}
                </div>
              ) : (
                <PortableModelList
                  options={sortedOptions}
                  filtered={filteredOptions}
                  filterActive={!!filter.trim()}
                  isMobile={isMobile}
                  hasClear={!!onClear}
                  isActive={(option) => option.modelId === value?.modelId && option.provider === value?.provider}
                  renderOption={(option, trailing) => (
                    <ModelOptionButton
                      active={option.modelId === value?.modelId && option.provider === value?.provider}
                      label={option.name}
                      onClick={() => choose(option)}
                      trailing={trailing}
                    />
                  )}
                />
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function ModelOptionButton({ active, label, onClick, trailing }: { active: boolean; label: string; onClick: () => void; trailing?: ReactNode }) {
  return (
    <button
      type="button"
      role="option"
      className="pw-model-row"
      aria-selected={active}
      onClick={onClick}
    >
      <span className="pw-model-row-check" aria-hidden="true">
        {active && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
      </span>
      <span title={label} className="pw-model-row-label" style={trailing ? { flex: 1 } : undefined}>{label}</span>
      {trailing}
    </button>
  );
}

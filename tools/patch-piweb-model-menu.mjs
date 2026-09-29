// Source integration: Claude-style model menu (lop 2026-09-29「主力用 astra、luna、sol 和 2 个
// gpt 网页模型，剩下的收起来放到 more 里面，最好是我能在前端直接设置」).
// Primary models are listed directly, the rest under "更多模型"; the star on each row pins or
// unpins a model, stored for every browser in <agentDir>/web-model-menu.json (/api/model-menu).
export function integrateModelMenu({ set, change, prepend, template }) {
  set('lib/portable-model-menu.mjs', template('portable-model-menu.mjs'));
  set('components/PortableModelList.tsx', template('PortableModelList.tsx'));
  set('app/api/model-menu/route.ts', template('portable-model-menu-route.ts'));
  const selector = 'components/ModelSelector.tsx';
  prepend(selector, 'import { PortableModelList } from "./PortableModelList";\n');
  change(selector, 'import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";', 'import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";');
  // The provider-grouped list becomes primary models + "更多模型"; filtering still lists every match.
  change(selector, `              ) : modelsByProvider.map((group, index) => (
                <div key={group.provider}>
                  {modelsByProvider.length > 1 && (
                    <div style={{ padding: "6px 12px 4px", borderTop: index > 0 || onClear ? "1px solid var(--border)" : "none", color: "var(--text-dim)", fontSize: 10, fontWeight: 600, letterSpacing: 0, textTransform: "uppercase" }}>
                      {group.provider}
                    </div>
                  )}
                  {group.options.map((option) => (
                    <ModelOptionButton
                      key={\`\${option.provider}:\${option.modelId}\`}
                      active={option.modelId === value?.modelId && option.provider === value?.provider}
                      label={option.name}
                      onClick={() => choose(option)}
                    />
                  ))}
                </div>
              ))}`, `              ) : (
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
              )}`);
  // Rows carry the pin star at their end; it shows on hover (always on touch screens).
  change(selector, 'function ModelOptionButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {', 'function ModelOptionButton({ active, label, onClick, trailing }: { active: boolean; label: string; onClick: () => void; trailing?: ReactNode }) {');
  change(selector, `      role="option"
      aria-selected={active}
      onClick={onClick}`, `      role="option"
      className="pw-model-row"
      aria-selected={active}
      onClick={onClick}`);
  change(selector, '<span title={label} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>\n    </button>', '<span title={label} style={{ flex: trailing ? 1 : undefined, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>\n      {trailing}\n    </button>');
}

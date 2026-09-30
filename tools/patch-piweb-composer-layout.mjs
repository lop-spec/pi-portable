// Source integration: composer control layout (lop 2026-09-30「标红部分还是应该放到右边，跟之前一样」).
// Upstream 0.9.3 moved the model selector from the right control group into the left one. The
// injected quota gauge and service-tier (⚡) controls anchor on `.model-selector.is-toolbar`, so
// they all jumped left with it. Put the selector back first in the right group, exactly where
// 0.9.0 had it; attach-image and the follow-up menu stay on the left as they were in 0.9.0.
const MODEL_SELECTOR = `            {(modelOptions.length > 0 || model || modelError) && onModelChange && (
              <ModelSelector
                options={modelOptions}
                value={model}
                onChange={onModelChange}
                disabled={isStreaming}
                busy={modelSwitching}
                isAutoSelection={isAutoModelSelection}
              />
            )}
`;

export function integrateComposerLayout({ change }) {
  const input = 'components/ChatInput.tsx';
  change(input, `            {/* Model selector - visible always, disabled while the session or switch is busy */}\n${MODEL_SELECTOR}`, '');
  change(input, '            {onThinkingLevelChange && (\n', `${MODEL_SELECTOR}            {onThinkingLevelChange && (\n`);
}

import type { ModelCatalog, ModelOption } from "@codexplatform/contracts";
import { useDismissiblePopover } from "./useDismissiblePopover.js";

export interface ModelSelection {
  model: string;
  reasoningEffort: string;
}

interface ModelEffortPickerProps {
  catalog: ModelCatalog | null;
  value: ModelSelection | null;
  onChange(value: ModelSelection): void;
  disabled?: boolean;
  loading?: boolean;
  error?: boolean;
}

export function normalizeModelSelection(model: ModelOption, effort: string | null): ModelSelection {
  const supported = model.supportedReasoningEfforts.find(
    (option) => option.value.toLowerCase() === effort?.toLowerCase(),
  );
  return {
    model: model.model,
    reasoningEffort: supported?.value ?? model.defaultReasoningEffort,
  };
}

export function resolveCatalogSelection(
  catalog: ModelCatalog | null | undefined,
  preferredModel: string | null | undefined,
  preferredEffort: string | null | undefined,
): ModelSelection | null {
  if (!catalog || catalog.models.length === 0) return null;
  const model =
    catalog.models.find((option) => option.model === preferredModel) ??
    catalog.models.find((option) => option.isDefault) ??
    catalog.models[0];
  return model ? normalizeModelSelection(model, preferredEffort ?? null) : null;
}

export function ModelEffortPicker({
  catalog,
  value,
  onChange,
  disabled = false,
  loading = false,
  error = false,
}: ModelEffortPickerProps) {
  const { close, open, rootRef, toggle, triggerRef } = useDismissiblePopover<HTMLFieldSetElement>();
  const selection = resolveCatalogSelection(catalog, value?.model, value?.reasoningEffort);
  const selectedModel = catalog?.models.find((model) => model.model === selection?.model) ?? null;

  if (loading) {
    return (
      <button type="button" className="model-effort-trigger" disabled>
        正在读取模型…
      </button>
    );
  }
  if (error || !catalog || !selection || !selectedModel) {
    return (
      <div className="model-effort-unavailable">
        <button type="button" className="model-effort-trigger" disabled>
          模型目录不可用
        </button>
        <span role="alert">无法读取 Runtime 模型目录，请稍后重试。</span>
      </div>
    );
  }

  const label = `${selectedModel.displayName} · ${selection.reasoningEffort}`;
  return (
    <fieldset ref={rootRef} className="model-effort-picker" aria-label="Model and Effort picker">
      <button
        ref={triggerRef}
        type="button"
        className="model-effort-trigger"
        aria-label={`Model and Effort: ${label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={toggle}
      >
        <span>{selectedModel.displayName}</span>
        <strong>{selection.reasoningEffort}</strong>
        <span aria-hidden="true">⌄</span>
      </button>
      {catalog.stale ? <span className="model-catalog-stale">模型目录可能已过期</span> : null}
      {open ? (
        <div className="model-effort-popover">
          <div className="model-option-list" role="listbox" aria-label="Runtime models">
            {catalog.models.map((model) => (
              <button
                type="button"
                role="option"
                aria-selected={model.model === selectedModel.model}
                key={model.id}
                onClick={() => onChange(normalizeModelSelection(model, null))}
              >
                <span>
                  <strong>{model.displayName}</strong>
                  <small>{model.description}</small>
                </span>
                {model.model === selectedModel.model ? <span aria-hidden="true">✓</span> : null}
              </button>
            ))}
          </div>
          <div className="effort-option-list" role="radiogroup" aria-label="Reasoning Effort">
            <span>Reasoning Effort</span>
            {selectedModel.supportedReasoningEfforts.map((effort) => (
              <label key={effort.value} title={effort.description}>
                <input
                  type="radio"
                  name={`reasoning-effort-${selectedModel.id}`}
                  value={effort.value}
                  checked={effort.value === selection.reasoningEffort}
                  onChange={() => {
                    onChange(normalizeModelSelection(selectedModel, effort.value));
                    close({ restoreFocus: true });
                  }}
                />
                <span>{effort.value}</span>
              </label>
            ))}
          </div>
          <footer>
            {catalog.scope === "SINGLE_ACCOUNT"
              ? "当前 Thread 运行账号"
              : `${catalog.accountCount} 个可调度账号的共同能力`}
          </footer>
        </div>
      ) : null}
    </fieldset>
  );
}

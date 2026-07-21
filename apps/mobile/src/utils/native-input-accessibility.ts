export interface NativeInputAccessibilityOptions {
  labelId: string;
  name: string;
  autocomplete?: HTMLInputElement["autocomplete"];
  min?: number;
  max?: number;
  step?: number;
}

/**
 * uni-app H5 会把 aria/name 留在 <uni-input> 容器上，这里同步到实际获取焦点的 input。
 * 其他端没有 DOM 时直接返回，仍使用模板上的 name/aria-label。
 */
export const syncNativeInputAccessibility = (
  rootId: string,
  options: NativeInputAccessibilityOptions
) => {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.getElementById(rootId);
  const input = root?.querySelector("input");
  if (!input) {
    return;
  }

  input.id = `${rootId}-native`;
  input.name = options.name;
  input.setAttribute("aria-labelledby", options.labelId);

  if (options.autocomplete) {
    input.autocomplete = options.autocomplete;
  }

  if (options.min !== undefined) {
    input.min = String(options.min);
  }
  if (options.max !== undefined) {
    input.max = String(options.max);
  }
  if (options.step !== undefined) {
    input.step = String(options.step);
  }
};

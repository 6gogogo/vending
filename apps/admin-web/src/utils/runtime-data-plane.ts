import type { ComputedRef, InjectionKey, Ref } from "vue";

export type RuntimeDataPlane = "simulation" | "live" | "unknown";

export const runtimeDataPlaneInjectionKey: InjectionKey<Ref<RuntimeDataPlane>> =
  Symbol("runtimeDataPlane");

export const runtimeStatusLabelInjectionKey: InjectionKey<ComputedRef<string>> =
  Symbol("runtimeStatusLabel");

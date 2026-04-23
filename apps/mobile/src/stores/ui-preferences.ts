import { defineStore } from "pinia";

import type { UserRole } from "@vm/shared-types";

import {
  readSpecialAccessibilityMode,
  writeSpecialAccessibilityMode
} from "../utils/accessibility-storage";

interface UiPreferencesState {
  specialAccessibilityMode: boolean;
  hydrated: boolean;
}

export const useUiPreferencesStore = defineStore("mobile-ui-preferences", {
  state: (): UiPreferencesState => ({
    specialAccessibilityMode: false,
    hydrated: false
  }),
  getters: {
    isAccessibilityEnabled: (state) => (role?: UserRole) =>
      state.specialAccessibilityMode && (!role || role === "special")
  },
  actions: {
    hydrate() {
      if (this.hydrated) {
        return;
      }

      this.specialAccessibilityMode = readSpecialAccessibilityMode();
      this.hydrated = true;
    },
    setSpecialAccessibilityMode(enabled: boolean) {
      this.specialAccessibilityMode = enabled;
      this.hydrated = true;
      writeSpecialAccessibilityMode(enabled);
    }
  }
});

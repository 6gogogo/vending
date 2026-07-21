<script setup lang="ts">
import { onLaunch } from "@dcloudio/uni-app";

import { useSessionStore } from "./stores/session";
import { useUiPreferencesStore } from "./stores/ui-preferences";

import "./styles/theme.css";

const sessionStore = useSessionStore();
const uiPreferencesStore = useUiPreferencesStore();

const installH5TabBarAccessibility = () => {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return;
  }

  const markIconsAsDecorative = () => {
    document
      .querySelectorAll<HTMLImageElement>("uni-tabbar img, .uni-tabbar img")
      .forEach((image) => {
        image.alt = "";
        image.setAttribute("aria-hidden", "true");
      });
  };

  markIconsAsDecorative();
  const observer = new MutationObserver(markIconsAsDecorative);
  observer.observe(document.documentElement, { childList: true, subtree: true });
};

onLaunch(() => {
  uiPreferencesStore.hydrate();
  sessionStore.bootstrap();

  // #ifdef H5
  installH5TabBarAccessibility();
  // #endif
});
</script>

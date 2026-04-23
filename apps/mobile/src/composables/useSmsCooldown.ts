import { computed, onBeforeUnmount, ref } from "vue";

export const useSmsCooldown = (defaultSeconds = 60) => {
  const remainingSeconds = ref(0);
  let timer: ReturnType<typeof setInterval> | undefined;

  const clearCooldown = () => {
    if (!timer) {
      return;
    }

    clearInterval(timer);
    timer = undefined;
  };

  const startCooldown = (seconds = defaultSeconds) => {
    clearCooldown();
    remainingSeconds.value = Math.max(0, Math.floor(seconds));

    if (remainingSeconds.value <= 0) {
      return;
    }

    timer = setInterval(() => {
      if (remainingSeconds.value <= 1) {
        remainingSeconds.value = 0;
        clearCooldown();
        return;
      }

      remainingSeconds.value -= 1;
    }, 1000);
  };

  onBeforeUnmount(() => {
    clearCooldown();
  });

  return {
    remainingSeconds,
    isCoolingDown: computed(() => remainingSeconds.value > 0),
    startCooldown,
    clearCooldown
  };
};

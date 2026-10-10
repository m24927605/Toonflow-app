import { computed } from "vue";
import { defineStore } from "pinia";
import { customProviders, saveSettings, settings } from "@/stores/settings";

export const useHelloStore = defineStore("hello", () => {
  const completed = computed(() => settings.value.helloCompleted === true);

  async function load() {
    if (typeof settings.value.helloCompleted === "boolean") return completed.value;
    let previouslyCompleted = false;
    try {
      previouslyCompleted = JSON.parse(localStorage.getItem("toonflow.hello") ?? "null")?.completed === true;
    } catch {
      // ACT: If the old cache is unreadable, fall back to configured models; localStorage can't migrate across
      // random desktop ports.
    }
    if (previouslyCompleted || customProviders.value.some(provider => provider.models.length))
      await complete();
    return completed.value;
  }

  async function complete() {
    await saveSettings(() => ({ helloCompleted: true }));
  }

  async function reset() {
    await saveSettings(() => ({ helloCompleted: false }));
  }

  return { completed, load, complete, reset };
});

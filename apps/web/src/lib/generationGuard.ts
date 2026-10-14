import { ref } from "vue";
import type { Router } from "vue-router";
import { ElMessageBox } from "element-plus";
import { translate } from "@toonflow/i18n/vue";

// Media generations running in this page. Leaving the workspace unmounts their nodes, and the server cancels a job no
// page polls any more (stopping its Colab session), so leaving while one runs wastes the time already spent.
const running = ref(0);

/** Counts one running generation until the returned function is called. */
export function beginGeneration() {
  running.value++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    running.value--;
  };
}

/** Asks before closing or reloading the page, or leaving the workspace, while a generation runs. */
export function guardGenerations(router: Router) {
  // Browsers show their own fixed text for this prompt.
  window.addEventListener("beforeunload", event => {
    if (running.value) event.preventDefault();
  });
  router.beforeEach((to, from) => {
    if (!running.value || from.path !== "/workspace" || to.path === "/workspace") return true;
    return ElMessageBox.confirm(
      translate("Generation is still running. Leaving the project stops it, and the time and credits already spent are lost. Leave anyway?"),
      translate("Generation in progress"),
      // The router uses the URL hash, so the box must not close itself when Back changes it mid-question.
      { confirmButtonText: translate("Leave"), cancelButtonText: translate("Stay"), type: "warning", closeOnClickModal: false, closeOnHashChange: false },
    ).then(() => true, () => false);
  });
}

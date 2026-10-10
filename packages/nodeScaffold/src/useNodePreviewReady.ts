import { inject, ref, watch, type Ref } from "vue";
import { useNode, useNodeId } from "@vue-flow/core";
import type { NodeDocumentContext } from "./nodeDocument";

const previewObserverKey = Symbol.for("toonflow.nodePreviewObserver");
type PreviewObserver = { observer: IntersectionObserver; targets: Map<Element, Set<Ref<boolean>>> };

export function useNodePreviewReady() {
  const nodeId = useNodeId();
  const documentContext = inject<NodeDocumentContext | undefined>("nodeDocument", undefined);
  const ready = ref(!nodeId || typeof IntersectionObserver === "undefined");
  if (ready.value) return ready;
  watch(() => documentContext?.targets.has(nodeId), visible => {
    if (visible) ready.value = true;
  }, { immediate: true, flush: "sync" });
  const { nodeEl } = useNode();
  const host = globalThis as typeof globalThis & { [previewObserverKey]?: PreviewObserver };
  if (!host[previewObserverKey]) {
    const targets: PreviewObserver["targets"] = new Map();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        targets.get(entry.target)?.forEach(value => { value.value = true; });
        targets.delete(entry.target);
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "240px" });
    host[previewObserverKey] = { observer, targets };
  }
  const { observer, targets } = host[previewObserverKey];
  // ACT: Mount the preview only when first near the viewport, then keep size, player and plugin UI state;
  // never unmount the node runtime.
  watch(nodeEl, (element, _previous, onCleanup) => {
    if (!element || ready.value) return;
    const subscribers = targets.get(element) ?? new Set<Ref<boolean>>();
    subscribers.add(ready);
    targets.set(element, subscribers);
    observer.observe(element);
    onCleanup(() => {
      subscribers.delete(ready);
      if (targets.get(element) === subscribers && !subscribers.size) {
        targets.delete(element);
        observer.unobserve(element);
      }
    });
  }, { immediate: true, flush: "post" });
  return ready;
}

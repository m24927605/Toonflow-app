import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";

export type MachineState = "disconnected" | "off" | "starting" | "working" | "idle" | "stopping" | "unknown";
export type MachineSnapshot = {
  checkedAt: string; working: boolean;
  machines: { lane: number; gpu: "L4" | "A100"; state: MachineState; checkedAt: string }[];
};
const states: MachineState[] = ["disconnected", "off", "starting", "working", "idle", "stopping", "unknown"];

function validSnapshot(value: unknown): value is MachineSnapshot {
  if (!value || typeof value !== "object") return false;
  const data = value as MachineSnapshot;
  return typeof data.checkedAt === "string" && Number.isFinite(Date.parse(data.checkedAt)) && typeof data.working === "boolean"
    && Array.isArray(data.machines) && data.machines.length >= 3 && data.machines.length <= 4
    && data.machines.every(row => row && Number.isInteger(row.lane) && row.lane >= 0 && row.lane < 4 && ["L4", "A100"].includes(row.gpu) && states.includes(row.state) && typeof row.checkedAt === "string" && Number.isFinite(Date.parse(row.checkedAt)))
    && new Set(data.machines.map(row => row.lane)).size === data.machines.length
    && [0, 1, 2].every(lane => data.machines.some(row => row.lane === lane));
}

export const useMachineStatusStore = defineStore("machineStatus", () => {
  const snapshot = shallowRef<MachineSnapshot>();
  const available = ref(false);
  const receivedAt = ref(performance.now());

  function connect() {
    const source = new EventSource("/api/ai/media/presence");
    receivedAt.value = performance.now();
    source.onmessage = event => {
      try {
        const data: unknown = JSON.parse(event.data);
        if (!validSnapshot(data)) throw new Error("Invalid machine status");
        snapshot.value = data;
        receivedAt.value = performance.now();
        available.value = true;
      } catch { available.value = false; }
    };
    source.onerror = () => { available.value = false; };
    return () => { source.close(); available.value = false; };
  }
  return { snapshot, available, receivedAt, connect };
});

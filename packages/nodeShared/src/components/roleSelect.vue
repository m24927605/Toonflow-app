<template>
  <span class="roleSelect nodrag">
    <el-select v-model="role" size="small" class="roleMenu" :placeholder="translate('Set role')" :aria-label="translate('Node role')" :title="translate('What this node is for; the shot flow only uses nodes with a role')">
      <el-option :label="translate('Plain')" value="" />
      <el-option v-for="item in roles" :key="item" :label="roleLabels[item]" :value="item" />
    </el-select>
    <el-input-number v-if="role === 'keyframe' || role === 'layout' || role === 'previs'" v-model="shot" size="small" :min="1" :step="1" stepStrictly controlsPosition="right" class="shotInput" :aria-label="translate('Shot number')" :placeholder="translate('Shot')" />
    <el-input v-if="role === 'character'" v-model="character" size="small" class="characterInput" :aria-label="translate('Character name')" :placeholder="translate('Character name')" />
    <el-input v-if="role === 'character'" v-model="outfit" size="small" class="characterInput" :aria-label="translate('Outfit')" :placeholder="translate('Outfit')"
      :title="translate('The same person in another outfit keeps the same name; the outfit, such as kimono or nude, tells their views apart')" />
    <el-input v-if="role === 'scene'" v-model="scene" size="small" class="characterInput" :aria-label="translate('Scene name')" :placeholder="translate('Scene name')"
      :title="translate('Every image of the same place keeps the same name; a scene LoRA with this name loads with its keyframes')" />
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useNode } from "@vue-flow/core";
import { ElInput, ElInputNumber, ElOption, ElSelect } from "element-plus";
import { translate } from "@toonflow/i18n/vue";
import type { NodeRole, NodeRoleData } from "../nodeRole";

const props = defineProps<{ roles: NodeRole[] }>();
const { node } = useNode<NodeRoleData>();
const roleLabels = computed<Record<NodeRole, string>>(() => ({
  script: translate("Script"), shotList: translate("Shot list"), prompt: translate("Shot prompt"),
  keyframe: translate("Keyframe"), character: translate("Character"), scene: translate("Scene"), layout: translate("Previs layout"),
  previs: translate("Previs"),
}));
const roles = computed(() => props.roles);
const role = computed({
  get: () => node.data.role && props.roles.includes(node.data.role) ? node.data.role : "",
  set: (value: NodeRole | "") => {
    if (value) node.data.role = value;
    else delete node.data.role;
  },
});
const shot = computed({
  get: () => node.data.shot,
  set: (value?: number) => {
    if (value) node.data.shot = value;
    else delete node.data.shot;
  },
});
const outfit = computed({
  get: () => node.data.outfit ?? "",
  set: (value: string) => {
    if (value.trim()) node.data.outfit = value;
    else delete node.data.outfit;
  },
});
const scene = computed({
  get: () => node.data.scene ?? "",
  set: (value: string) => {
    if (value.trim()) node.data.scene = value;
    else delete node.data.scene;
  },
});
const character = computed({
  get: () => node.data.character ?? "",
  set: (value: string) => {
    // Kept as typed, so spaces inside a name survive typing; readers trim it.
    if (value.trim()) node.data.character = value;
    else delete node.data.character;
  },
});
</script>

<style lang="scss" scoped>
.roleSelect {
  display: inline-flex;
  align-items: center;
  gap: 4px;

  .roleMenu { width: 104px; }
  .shotInput { width: 76px; }
  .characterInput { width: 96px; }
}
</style>

<template>
  <el-dialog v-model="visible" :title="translate('Build shot nodes')" width="560px" appendToBody @closed="emit('closed')">
    <div class="shotNodesDialog">
      <p class="summary">{{ summary }}</p>
      <p v-if="plan.scripts.length" class="summary">{{ t`Original script: ${plan.scripts.map(item => item.label).join(", ")}. Each shot's text node also reads it.` }}</p>
      <p v-else class="hint">{{ translate("Tip: connect the original script's text node into this shot list, so each shot's text node can read the whole story instead of one row.") }}</p>
      <template v-if="plan.keyframesToBuild.length">
        <section v-if="plan.scenes.length">
          <h4>{{ translate("Scenes") }}</h4>
          <el-checkbox v-for="item in plan.scenes" :key="item.nodeId" v-model="sceneChecks[item.nodeId]">{{ item.label }}</el-checkbox>
        </section>
        <section v-if="plan.characters.length">
          <h4>{{ translate("Characters") }}</h4>
          <div v-for="item in plan.characters" :key="item.name" class="characterRow">
            <el-checkbox v-model="characterChecks[item.name]" :aria-label="item.name" />
            <el-input v-model="characterNames[item.name]" size="small" class="characterName" :disabled="!characterChecks[item.name]" :aria-label="translate('Character name')" />
            <el-select v-model="characterViews[item.name]" size="small" :disabled="!characterChecks[item.name]" :aria-label="translate('Default view')">
              <el-option v-for="cell in item.cells" :key="cell.nodeId" :label="cell.label" :value="cell.nodeId" />
            </el-select>
          </div>
        </section>
      </template>
      <section v-if="loraRows.length" class="loraSection">
        <h4>{{ translate("LoRA (keeps faces and places the same in every shot)") }}</h4>
        <div v-for="row in loraRows" :key="row.label" class="loraRow" :class="{ loraMissing: row.unnamed || !row.keyframe || row.video === false }">
          <strong>{{ row.label }}</strong>
          <span v-if="row.unnamed">{{ translate("No scene name yet: type it in the box next to the Scene role on the image, then click Train LoRA") }}</span>
          <template v-else>
            <span v-if="row.video !== undefined">{{ row.video ? translate("Video ✓") : translate("Video ✗") }}</span>
            <span>{{ row.keyframe ? translate("Keyframe ✓") : translate("Keyframe ✗") }}</span>
          </template>
        </div>
        <small v-if="loraRows.some(row => row.unnamed || !row.keyframe || row.video === false)">{{ translate("For each ✗, click Train LoRA on one of that person's or place's images and build after it finishes (about 30–60 minutes), so the new nodes load it. Building now works, but faces and rooms may drift between shots.") }}</small>
      </section>
      <section v-if="plan.keyframesToBuild.length && castPeople.length" class="castSection">
        <h4>{{ translate("Cast per shot") }}</h4>
        <small>{{ plan.castColumn ? translate("Preset from the shot list's cast column; untick anyone who is not in a shot.") : translate("The shot list has no cast column, so everyone is ticked; untick anyone who is not in a shot.") }} {{ translate("Tick a person even when only part of them is in frame, such as a hand, their back or a silhouette, so their skin, hair and clothing stay consistent.") }}</small>
        <div class="castScroll">
          <table class="castTable">
            <thead>
              <tr>
                <th>{{ translate("Shot") }}</th>
                <th v-for="person in castPeople" :key="person">{{ person }}</th>
                <th v-if="plan.castColumn">{{ translate("Shot list") }}</th>
                <th v-if="hasState">{{ translate("Character state") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="span in plan.keyframesToBuild" :key="span.shot">
                <td>{{ span.shot }}</td>
                <td v-for="person in castPeople" :key="person">
                  <el-checkbox v-if="outfitsOf(person).length === 1" :modelValue="castChoice[span.shot]![person] === outfitsOf(person)[0]!.name"
                    :aria-label="`${span.shot} ${person}`" @update:modelValue="castChoice[span.shot]![person] = $event ? outfitsOf(person)[0]!.name : ''" />
                  <el-select v-else v-model="castChoice[span.shot]![person]" size="small" class="outfitSelect" :aria-label="`${span.shot} ${person}`">
                    <el-option :label="translate('Not in shot')" value="" />
                    <el-option v-for="item in outfitsOf(person)" :key="item.name" :label="item.outfit ?? item.name" :value="item.name" />
                  </el-select>
                </td>
                <td v-if="plan.castColumn" class="castCell">{{ span.cast }}</td>
                <td v-if="hasState" class="castCell">{{ span.state }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section v-if="plan.keyframesToBuild.length">
        <h4>{{ translate("Master shot") }}</h4>
        <el-select v-model="masterShot" size="small" class="masterSelect" :aria-label="translate('Master shot')">
          <el-option :label="translate('None')" :value="0" />
          <el-option v-for="shot in masterOptions" :key="shot" :label="t`Shot ${shot}`" :value="shot" />
        </el-select>
        <small v-if="suggestionText" class="suggestion">{{ suggestionText }}</small>
        <small>{{ translate("Every other keyframe also references the master shot's keyframe for lighting, colour, clothing and props. Generate and approve the master shot first, then the rest.") }}</small>
      </section>
      <section v-if="plan.keyframesToBuild.length">
        <h4>{{ translate("Keyframe prompt template") }}</h4>
        <el-input v-model="template" type="textarea" :autosize="{ minRows: 4, maxRows: 10 }" :aria-label="translate('Keyframe prompt template')" />
        <small>{{ shotHint }}</small>
      </section>
      <section v-if="plan.videosToBuild.length">
        <h4>{{ translate("Video prompt template") }}</h4>
        <el-input v-model="videoTemplate" type="textarea" :autosize="{ minRows: 2, maxRows: 8 }" :aria-label="translate('Video prompt template')" />
        <small>{{ shotHint }}</small>
      </section>
      <section>
        <el-checkbox v-model="textNodes">{{ translate("Also create one text node per shot, connected to this shot list") }}</el-checkbox>
      </section>
    </div>
    <template #footer>
      <el-button @click="visible = false">{{ translate("Cancel") }}</el-button>
      <el-button type="primary" :disabled="!plan.keyframesToBuild.length && !plan.videosToBuild.length" @click="build">{{ translate("Build") }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ElButton, ElCheckbox, ElDialog, ElInput, ElOption, ElSelect } from "element-plus";
import { t, translate } from "@toonflow/i18n/vue";
import type { ShotNodesPlan } from "./shotNodes";
import { keyframeTemplate } from "@toonflow/node-shared/keyframePrompt";

/** A person (with `video`) or a place of the shot list and whether its LoRAs are trained; `unnamed` scenes cannot have one yet. */
export type LoraRow = { label: string; video?: boolean; keyframe: boolean; unnamed?: boolean };
/** `cast` lists, per shot, the indexes into `characters` of the people in that shot; `masterShot` is 0 for none. */
export type ShotNodesChoice = {
  scenes: string[]; characters: { name: string; person: string; cells: string[] }[]; cast: Record<number, number[]>; masterShot: number;
  template: string; videoTemplate: string; textNodes: boolean;
};

const props = defineProps<{ plan: ShotNodesPlan; loraRows: LoraRow[] }>();
const emit = defineEmits<{ build: [choice: ShotNodesChoice]; closed: [] }>();
const visible = ref(true);
const sceneChecks = reactive(Object.fromEntries(props.plan.scenes.map(item => [item.nodeId, true])));
const characterChecks = reactive(Object.fromEntries(props.plan.characters.map(item => [item.name, true])));
const characterNames = reactive(Object.fromEntries(props.plan.characters.map(item => [item.name, item.name])));
const characterViews = reactive(Object.fromEntries(props.plan.characters.map(item => [item.name, item.cells[0]!.nodeId])));
const textNodes = ref(true);
// The suggested master shot is preselected; it can be changed or set to none.
const masterShot = ref(props.plan.keyframesToBuild.length ? props.plan.masterSuggestion?.shot ?? 0 : 0);
const suggestionText = computed(() => {
  const suggestion = props.plan.masterSuggestion;
  if (!suggestion) return "";
  if (suggestion.reason !== undefined) return [t`Suggested by the shot list: shot ${suggestion.shot}.`, suggestion.reason].filter(Boolean).join(" ");
  const size = suggestion.size ?? "";
  return suggestion.cast.length
    ? t`Suggested: shot ${suggestion.shot}, the widest shot with the most characters in frame (${[size, suggestion.cast.join(", ")].filter(Boolean).join("; ")}).`
    : t`Suggested: shot ${suggestion.shot}, the widest shot${size ? ` (${size})` : ""}.`;
});
// The master shot can be a shot built now or one whose keyframe node already exists.
const masterOptions = computed(() => [...new Set([...props.plan.keyframesToBuild.map(span => span.shot), ...props.plan.keyframes.keys()])].sort((a, b) => a - b));
// Each person is one column; with several outfits the cell picks which one this shot uses.
const castPeople = computed(() => [...new Set(props.plan.characters.filter(item => characterChecks[item.name]).map(item => item.person))]);
const outfitsOf = (person: string) => props.plan.characters.filter(item => item.person === person && characterChecks[item.name]);
// Who is in each shot comes from the shot list's cast column (a person counts when their name is in the cell) or, without
// one, everyone. The outfit is the one whose name the shot's row mentions (its state cell first), else the first one;
// the user has the last word here, never the text model.
const castChoice = reactive(Object.fromEntries(props.plan.keyframesToBuild.map(span => [span.shot, Object.fromEntries(
  [...new Set(props.plan.characters.map(item => item.person))].map(person => {
    const outfits = props.plan.characters.filter(item => item.person === person);
    if (span.cast !== undefined && !span.cast.includes(person) && !outfits.some(item => span.cast!.includes(item.name))) return [person, ""];
    const text = `${span.state ?? ""} ${span.row ?? ""}`;
    return [person, (outfits.find(item => item.outfit && text.includes(item.outfit)) ?? outfits[0]!).name];
  }))])));
const hasState = props.plan.keyframesToBuild.some(span => span.state);
const template = ref("");
// Music is laid over the joined film afterwards, so every shot keeps only the sound of the scene and cuts stay seamless.
const videoTemplate = ref([
  translate("Start from the first frame {{ref 1}} and keep the people, clothing and set unchanged."),
  "{{shot}}",
  translate("No background music: only dialogue and the sounds of the scene."),
].join("\n"));
// Kept out of the template: the marker's braces would end a template interpolation.
const shotHint = computed(() => translate("{{shot}} marks where Distribute prompts puts each shot's text."));

const summary = computed(() => {
  const { keyframesToBuild, videosToBuild, waiting } = props.plan;
  const shots = (spans: { shot: number }[]) => spans.map(item => item.shot).join(", ");
  return [
    keyframesToBuild.length ? t`Create ${keyframesToBuild.length} keyframe image generation nodes (shots ${shots(keyframesToBuild)}) connected to the references below.` : "",
    videosToBuild.length ? t`Create ${videosToBuild.length} video generation nodes (shots ${shots(videosToBuild)}), each starting from its shot's keyframe with the shot length as duration.` : "",
    waiting.length ? t`Shots ${waiting.join(", ")} wait for their keyframes; generate them, then build again to add their videos.` : "",
    !keyframesToBuild.length && !videosToBuild.length && !waiting.length ? translate("Every shot already has its keyframe and video nodes.") : "",
  ].filter(Boolean).join(" ");
});

// References connect in this order: scenes, then every view of each character; the template names one view each.
const order = computed(() => {
  const scenes = props.plan.scenes.filter(item => sceneChecks[item.nodeId]).map(item => item.nodeId);
  const characters = props.plan.characters.filter(item => characterChecks[item.name]).map(item => ({ key: item.name, person: item.person, name: characterNames[item.name]!.trim() || item.name, cells: item.cells.map(cell => cell.nodeId) }));
  return { scenes, characters };
});

// Changing the reference choices rebuilds the template; edits made after the last change are kept until then.
watch([order, () => ({ ...characterViews }), () => ({ ...characterNames })], () => {
  const { scenes, characters } = order.value;
  let next = scenes.length + 1;
  const named = characters.map(item => {
    const ref = next + item.cells.indexOf(characterViews[item.key]!);
    next += item.cells.length;
    return { name: item.name, ref };
  });
  template.value = keyframeTemplate(scenes.map((_, index) => index + 1), named).map(line => typeof line === "string" ? line : translate(line)).join("\n");
}, { immediate: true, deep: true });

function build() {
  const characters = order.value.characters;
  const cast = Object.fromEntries(props.plan.keyframesToBuild.map(span => [span.shot, characters.flatMap((item, index) => castChoice[span.shot]![item.person] === item.key ? [index] : [])]));
  emit("build", { scenes: order.value.scenes, characters: characters.map(item => ({ name: item.name, person: item.person, cells: item.cells })), cast, masterShot: masterShot.value, template: template.value, videoTemplate: videoTemplate.value, textNodes: textNodes.value });
  visible.value = false;
}
</script>

<style lang="scss" scoped>
.shotNodesDialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  .summary { margin: 0; }
  .hint { margin: 0; font-size: 12px; color: var(--el-text-color-secondary); }
  section {
    display: flex;
    flex-direction: column;
    gap: 4px;
    h4 { margin: 0; font-size: 13px; }
    small { color: var(--el-text-color-secondary); }
  }
  .loraRow {
    display: flex;
    gap: 12px;
    font-size: 12px;
    &.loraMissing { color: var(--el-color-warning); }
  }
  .masterSelect { width: 160px; }
  .outfitSelect { width: 96px; }
  .castTable {
    border-collapse: collapse;
    font-size: 12px;
    th, td { padding: 2px 8px; text-align: center; border-bottom: 1px solid var(--el-border-color-lighter); }
    // The header row stays in view while the shots scroll, so each column's person is always visible.
    th { position: sticky; top: 0; z-index: 1; background: var(--el-dialog-bg-color, var(--el-bg-color)); }
    .castCell { text-align: left; color: var(--el-text-color-secondary); }
  }
  .suggestion { display: block; color: var(--el-color-primary); }
  .castScroll {
    max-height: 260px;
    overflow: auto;
  }
  .characterRow {
    display: flex;
    align-items: center;
    gap: 8px;
    .characterName { width: 140px; }
    .el-select { width: 220px; }
  }
}
</style>

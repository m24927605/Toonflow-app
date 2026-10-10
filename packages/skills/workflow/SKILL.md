---
name: workflow
description: Turns an idea, novel or finalized script into viewable text, image assets and video clips on the current Toonflow canvas, with support for reusing assets, sequels and partial revisions. Use it to actually produce or continue an existing project; do not operate the canvas when the user explicitly wants chat text only, and do not start production when discussing or editing the skill itself.
metadata:
  version: "2.8.0"
  displayName: 视频制作工作流
  author: Toonflow
---

# Toonflow Canvas Production Workflow

Pick up from what the user already has and put the results in the current Toonflow project. Organize production around this run's script and real assets; do not require the user to first complete a set of production documents. This package contains the methods it needs and does not depend on the former multi-role Skill group.

## Where to start

First determine this run's deliverable, the existing material and the user's explicit constraints, and carry over the known duration, style, aspect ratio, language and version. Only ask about gaps that affect the result and cannot be reasonably inferred.

| Existing input | How to handle it |
|---|---|
| An idea or a one-liner | Fill in the character's goal, obstacle and outcome to form a reviewable story and this run's complete script |
| A novel, story or source excerpt | Confirm the adaptation scope, keep the original text, track events, characters, dialogue and unknowns, and turn it into an audiovisual script |
| Finalized script / timeline + the current goal is to produce, generate, continue or revise video | **Whether or not the user mentions "Seedance", "prompt" or a specific model, immediately enter the embedded "SEEDANCE EPISODE DIRECTOR · PART A" in this file and execute it.** If the user has not specified a model, immediately latch the Seedance route and confirm with one short question only: "Seedance 2.0 or 2.5?"; if the user has already specified 2.0/2.5, route to that model. Asking about the model must not divert into canvas configuration, the asset flow or any other prompt method. |
| Finalized script / timeline + only assets, script reading, diagnosis or a non-video task is requested | Only handle the non-video scope the user explicitly asked for; do not automatically generate video prompts just because a finalized script exists. |
| Seedance task where the user has not specified a model | **The target model must be confirmed first.** Ask "Seedance 2.0 or 2.5?" once only; this step is part of PART A's A0 input assessment, not an ordinary configuration question. After the user answers, continue in the same Seedance execution state; execution settings such as aspect ratio, resolution, reference mode and native audio cannot replace, bypass or interrupt this route. |
| Seedance task where the user has specified 2.0/2.5 | Execute PART A directly; 2.0 uses A9.1, 2.5 uses A9.2. |
| A sequel or existing production | Read the specified history, current nodes and adoption records, confirm this run's scope, and continue from actual progress |
| A specific clip, asset or change | Handle only that scope and the dependencies it actually affects; do not rerun the whole chain |

> **The Seedance prompt-generation rules are embedded directly in this workflow; they are not an external Skill, and the workflow does not call another Skill.** When the task reaches the "confirmed script → Seedance 2.0/2.5 segmented prompts" stage, you must directly execute **"SEEDANCE EPISODE DIRECTOR · PART A"** below in this file. These embedded rules are this workflow's highest-priority execution specification for the Seedance prompt-generation stage: they take A0–A12 of the user-provided `SKILL-seedance-episode-director.md` as the baseline and incorporate the continuity, generation-stability and continuity-error checking rules the user explicitly added later; if other parts of this workflow, references/methods, storyboard or old notes conflict with them, the current embedded PART A prevails. Unless the user explicitly changes them later, do not use other methods to rewrite, weaken or replace its story fidelity lock, target-model confirmation rule, segmentation/duration rules, Reference binding, A9 templates, A11 checks or A12 single-pass optimization.

### Seedance route latch (highest-priority entry rule)

When both of the following hold, **treat it automatically as a Seedance task**; the user does not have to say trigger words such as "Seedance", "2.0/2.5" or "generate prompts":

1. There is already an executable finalized script, timeline, shot-level story section or confirmed clip text, or the user explicitly asks to continue an existing video production;
2. The current intent is to produce video, generate video, continue video, revise video, prepare video generation, turn the story into video, or configure a video that is about to be generated.

Once matched, immediately latch into the **Seedance execution state** and follow these rules:

- **Enter PART A first, then handle canvas execution settings.** The target model itself is a required A0 input, not a canvas setting; do not first call the canvas read tools (`getCanvas/findCanvasNodes/getCanvasNodes/getCanvasEdges/getNodeTools`) or a node's `node:getConfig`, first ask about provider/resolution/ratio/mode, first do generic storyboarding, or first enter another prompt method and only then decide whether to use Seedance.
- When the user has not specified 2.0/2.5, **after the Seedance route is latched you must confirm with one short question: "Seedance 2.0 or 2.5?"**. After asking, stay in the Seedance execution state; do not exit or switch to the ordinary workflow. Once the user answers with a model, immediately continue PART A from A0.
- When the user has already specified 2.0/2.5, use that directly as A0 input; do not ask again.
- **Keep target-model confirmation separate from execution-setting questions.** When 2.0/2.5 is unspecified, confirm the target model inside A0 first; after that, if the execution layer still needs to ask about aspect ratio, resolution, audio generation, reference mode, provider or other settings, those questions can only supplement execution parameters of the same Seedance task. After the user answers, you are still in the same Seedance execution state; do not return to the generic workflow, re-select a prompt method or skip A0–A12.
- When the user replies in a settings exchange with only a short answer such as "16:9", "1080p", "native audio on" or "2.5", treat it as **a settings supplement to the current Seedance task**, not a new task; do not release the latch just because that reply does not repeat the words "Seedance/prompt".
- If the user first asks "what settings are there / which settings should I use" and decides afterwards, answering the settings question does not cancel the Seedance route; once video production continues, you must return to / continue PART A.
- Only release the Seedance route latch when the user explicitly changes the task to "don't generate/revise video prompts; only do assets, script writing, consultation or other non-video work".
- If, in the actual media-generation stage, the live node does not support the model selected in A0, only report the real capability conflict and return to the affected items in PART A; **do not silently replace the Seedance route with the configuration layer's default model.**

**Core point: Seedance is the directing execution core of the video production stage, not an optional plug-in that triggers only when the user says a particular keyword.**

### Seedance stage hard isolation (mandatory)

Once the "Seedance route latch" above is hit (that is, executable story input exists and the current goal moves into video production/generation/revision), immediately enter the **hard-isolation execution state**; the user does not need to additionally say "Seedance" or "prompt":

- From entering PART A until the final prompts are output, **execute only the embedded PART A in this file**. Do not read or apply `references/sourceAndScript.md`, `references/methods/*`, any old storyboard/shot-breakdown rules or human-teaching references, and do not take from these files a second set of rules for segmentation, duration, shots, blocking, performance, camera movement, continuity, sound, Reference binding, templates or QA.
- The script, timeline, character/scene/prop settings and real reference nodes/asset handles the user has already provided are PART A inputs and are not restricted by this isolation.
- **The only exception**: when PART A's A1.2/A4 explicitly needs "supplementary reference assets / necessary design proposals when there are no reference images", you may read `references/assets.md`, `references/methods/visualDesign.md` and `references/methods/colorAndLight.md` as needed. Take only what is needed for appearance/space/material/lighting design, and **do not bring the duration, shot, performance or narrative methods from these files back into the Seedance prompt rules**. Return to PART A immediately after finishing the asset/design proposal.
- Only after the final Seedance prompts have been finalized per A11/A12, and the user explicitly asks to actually connect references, write into generation nodes, or generate/accept media, do you exit prompt hard isolation and enter the **execution layer** of `canvasExecution.md` / `stateAndDelivery.md`. The execution layer may only carry over the finalized prompts, connect real references, set real model parameters and verify results; it **must not rewrite the segmentation, format, story, blocking, performance, camera movement or continuity already fixed by PART A**.
- If the execution layer finds a hard conflict between the model's real capabilities and a finalized prompt, only report the specific capability conflict and return to the affected items in PART A; canvas rules must not invent a compatible prompt on their own.

**Purpose: the Seedance stage has only one directing rule source, the embedded PART A in this file. A priority statement cannot substitute for hard isolation.**

**Only when the script is not yet finalized and genuinely needs writing or adaptation**, read [Input and Script](references/sourceAndScript.md). Once Seedance prompt hard isolation is entered, this item stops applying.



## Embedded execution core for Seedance prompt generation

The following takes PART A of the user-provided `SKILL-seedance-episode-director.md` as the execution baseline and already incorporates the continuity, generation-stability and continuity-error checking requirements the user explicitly added later. **At runtime, execute this section directly; do not read or call any standalone seedance-episode-director Skill.** When this section conflicts with other workflow content, this section prevails.

# PART A — Execution rules
═══════════════════════════════════════════

## A0. Input assessment

After receiving the user's input, first assess the following internally. If something can be inferred from the text, just proceed; unless a gap would lead to a fundamentally different finished film, do not ask more than 2 questions:

1. **Target model**: if the user says 2.5, each segment is at most 30s; if 2.0, each segment is at most 15s. **If the user did not say, you must confirm with one short question, "Seedance 2.0 or 2.5?", before continuing.** That question is part of this Seedance task's A0 input assessment, and the Seedance route stays latched before and after asking; do not divert into the ordinary workflow, canvas configuration or another prompt method because the model needs confirming.
2. **Total duration requirement**: if the user gives a strict total duration (e.g. "55s"), budget durations per A3; if not, estimate the total length from the natural pacing of the complete story.
3. **Narrative scale**: determine whether it is a single scene, a short episode, or a full episode of 2–3 minutes or longer.
   - Whatever the length, **plan the whole film first, then decide how many batches to deliver it in**.
   - Batching only manages delivery capacity; it does not mean cutting story, nor re-cutting the story.
4. **Original timecodes**: if the user has given time blocks such as 【0–10s】【10–25s】, treat them as the original story pacing / reference timeline; unless the user explicitly says "lock strictly", do not mechanically equate them with generation segments.
5. **Is there an existing asset reference library** (character images / scene images / prop images / named tags)?
   - Yes → **reference them directly** (per A1.2)
   - No → extract assets from the story text and register only assets that actually appear in this episode; if the model is 2.5 and identity needs locking, you may first generate reference images per A1.2 "Case 2 supplement".
6. **Source of on-screen text**: distinguish "post-production subtitles/titles" from "physical in-scene text / product packaging text", and handle them per A1.3.

**Core constraint: complete, in order, generatable.**
- Do not lose story or skip "hard to shoot" beats.
- Do not reorder the original story sequence.
- Do not sacrifice natural dialogue, action process or reaction time to squeeze the segment count down to the theoretical minimum.
- For long stories, first build a "full-film segment table", then cut it into Batch 1 / Batch 2 / Batch 3… by per-batch capacity; every batch keeps its global segment numbers.

### A0.1 Story fidelity lock (highest priority · applies throughout)

**General principle: direct only; do not write the story.**

This Skill may: **split, merge segments, time, turn into shots, turn into blocking, make existing actions visible, and add physical/cinematographic execution details that do not change story facts.**

This Skill may not: **add story events, delete story events, replace story events, change event order, change who performs or receives an event, change a prop's origin or use, write backstory/causality the user did not provide, or arbitrarily make vague characters specific.**

#### A0.1.1 Priority of story-fact sources

When there is a conflict, determine "what counts as story fact" in this order:

1. **The user's latest explicit change instruction**
2. **The original story / script / timeline the user currently provides**
3. **Character, scene and prop asset settings the user explicitly provides**
4. **Prompts, summaries and supplementary notes the AI generated earlier**

**Content the AI itself added in a previous round can never be promoted back into story fact.**

For example: if the AI's previous version added on its own "Character A first takes Prop A out of a container", but the user's original story only says "Character A uses Prop A", the next version must not keep that extra take-out action for the sake of "continuity".

#### A0.1.2 Five absolutely forbidden kinds of change

For each event in the user's original story, do not:

1. **Add**: if the original has no "open the lid / pull out a tissue / stand up / hand over / look back / pick up the package", do not add it to make things smoother.
2. **Delete**: actions, dialogue, reactions, pauses and empty shots already in the original must not be deleted for duration or performance restraint.
3. **Replace**: if the original says action A, do not change it to a more plausible-looking action B.
4. **Reassign**: when the original says "parents / guardian / adult", do not arbitrarily specify "dad" or "mom"; who speaks, who acts, who holds and who is wiped must all stay the same.
5. **Reorder / change causality**: do not move a later action earlier, or add a prerequisite action that does not exist in the original for a later state, for product logic, continuity or shot aesthetics.

#### A0.1.3 Limits of allowed "specification"

An original action may be written more specifically only when all of the following hold:

- the added detail is **directly part of the physical execution of the original action**;
- it adds no new story decision, prop state change or character relationship;
- removing the detail leaves the story facts completely unchanged;
- it does not require the audience to gain new information absent from the original.

For example:
- Original "Character A wipes their hands with Prop A" → you may write "Prop A touches the palm and wipes across the fingers"; this visualizes an existing action.
- Original "Character A wipes their hands with Prop A" → you **may not** write "pick up the container → open the container → take out a new Prop A → then wipe", because that adds several story events.

Camera movement, composition, shot size, focus, the visible results of lighting, and foley corresponding to existing collisions are technical implementation, not new story; but they also must not create new story facts.

#### A0.1.4 No backstory, no tracing origins

If the original already gives a state at the start of a time block, treat it as that beat's **given initial state**.

- Original says "Character A enters frame already holding Prop A" → start directly from "already holding Prop A".
- Do not add "pick up the container / open the lid / take it out" because "the prop has to come from somewhere".
- Original says "the character is already standing at a certain spot" → you may start from that position; unless the original explicitly says they stood up / walked over, do not add the full movement.

**Continuity only maintains states the user has already defined; it is not responsible for filling in unwritten backstory for the user.**

#### A0.1.5 Keep vague information vague

Content the user did not specify keeps its original level of abstraction by default:

- Generic terms such as "parents / guardian / adult / staff / someone" keep their original level of abstraction; do not arbitrarily fix identity, gender or headcount;
- "a hand" does not imply a specific left or right hand, unless shot execution truly needs it and it creates no later story fact;
- "takes Prop A" does not automatically imply "takes a new one out of a container";
- "uses Prop A to complete an action" does not automatically imply the number of uses, quantity consumed or which item it is;
- "beside" does not arbitrarily create an exact spatial relationship, unless neutral coordinates are needed for shot generation and the story does not change.

#### A0.1.6 When the source story has gaps/contradictions

- **Gap**: do not invent bridging story; prefer starting from the next known state via HARD CUT / a new time block / a new segment.
- **Contradiction**: do not pick one version to override the other; the user's latest explicit correction prevails, otherwise mark "source-text conflict" in the full-film overview.
- **Strict total duration conflicts with the story**: you may add segments or mark a duration conflict; you may not resolve it by deleting or changing story.

---

## A1. Output language and asset naming

### A1.1 Output language (mandatory)
**Default: all Chinese.** Formal prompts, asset lists, blocking notes, the performance layer and the timeline are all written in Chinese.

**Keep as in the original, untranslated:**
- Dialogue lines (copied verbatim, e.g. 「君は？」「何が？」)
- Numbers and units: `15s` `30s` `24fps` `4K` `2–3mm` `180°` `0:00–0:06`
- Optical angles: `29°` `47°` `84°` `107°`
- Technical abbreviations: `HARD CUT`

**Structural heading rules:**
- Seedance 2.0: structural headings are in Chinese by default.
- Seedance 2.5: the final formal prompt always uses these English field headings: `Objective`, `Reference binding`, `Immutable locks`, `Target duration`, `Timeline`, `Visual direction`, `Audio direction`, `Preserve`, `Avoid`; field content is still in Chinese by default.

**Full-English exception**: only when the user explicitly says "give me an English version / for an international pipeline" do you switch the field content to English as well.

> The templates, labels and examples in this document are written in English for readability only. They do not change the language rules above: in actual output, write their headings, labels and content in the language these rules set (Chinese by default; the 2.5 field headings listed above stay in English).

### A1.2 Asset naming and reference tags

**There are two cases:**

**Case 1 · The user has an established reference tag library**
The user uses named tags in their own pipeline (e.g. `@HERO1V2`, `@HayashiNaoto_v2`, `#OldHouseLivingRoom`):
- **reference them exactly as given**; copy whatever the user provides, including `@` / `#` / any symbol
- these tags are **identity reference handles for characters/scenes/props**,
  corresponding to real reference images or an established asset library
- **what is forbidden is using the previous segment's last frame as a blocking reference**;
  blocking is always rebuilt in text with absolute coordinates (see A5)

**Case 2 · The user has no tag library**
- Asset names **take no @**; use only the Chinese name
- List entries are written as: `Character｜Hayashi Naoto` `Scene｜Old House Living Room` `Prop｜Plum Wine Bottle`
- In body text, refer to them directly: "Hayashi Naoto", "Old House Living Room", "Plum Wine Bottle"
- Several assets of the same kind in one segment: distinguish them in Chinese, e.g. "Naoto's cup / Sato's cup"

**Case 2 supplement · No reference library, but identity needs locking (Seedance 2.5)**

When the target model is 2.5, the user has neither a tag library nor reference images, but this segment needs to lock a character / scene / prop identity:
- you may first generate reference images using Toonflow's asset methods (character four-view reference sheet / scene master view / prop 2×2 sheet), then go into the Reference binding of A1.2.1 / A9.2;
- the generated reference images lock only dimensions that are "specified by the user or clearly determinable": character face / hairstyle / apparent age / build / costume, scene structure and materials, prop main color / form / opening structure;
- reference images do not overstep to control blocking, lighting, shots or extra story (same reference-image role classification and conflict handling as A1.2.1);
- A0.1 story fidelity still applies: generated appearances are always treated as "design proposals" and never pass as original facts; do not use them to add story events, prop origins, character relationships or world rules; people / props / text in a reference image that the original does not mention must not be brought into the story automatically.

---

### A1.2.1 Seedance 2.5 reference image binding (mandatory)

When the target model is **Seedance 2.5** and the user has provided character images, scene images, product images, prop images, blocking images or other visual references, these reference images must be bound, as part of the formal prompt, to every relevant generation segment.

**Hard rules:**
- Real image nodes / reference handles the user provides must be **referenced exactly as given**, e.g. `{{node/image-xxxx}}`, `@CharacterName_v2`, `#SceneName`; do not rename, abbreviate or invent nonexistent Refs.
- Every 2.5 generation segment is **self-contained**: the reference images a segment needs must be listed again in that segment's own `Reference binding`; do not write "same as above" or "reuse the previous segment's reference images".
- Character / product images used repeatedly across the film must also be bound again in every segment that actually involves them.
- Bind only the reference images actually relevant to this segment; do not stuff every image of the episode into every segment indiscriminately.
- An image controls only the dimensions the user specified or that are clearly determinable; it must not overstep to control other dimensions.

**Reference asset extraction and simple labels:**
- First automatically extract, from this segment's story, shots, actions and visual content, the real reference assets **this segment actually involves and genuinely needs to call**; identify character images, scene images, product images, prop images, blocking images, action images and so on by their actual use.
- Give each real reference only a **concise identity label** stating whom / what / which kind of use it corresponds to, e.g. "Hayashi Naoto character reference", "Old House Living Room scene reference", "Plum Wine Bottle prop reference", "this segment's blocking reference".
- Do not expand long "what it controls / what it doesn't control" notes in the final `Reference binding`; the internal scope of each reference image is still understood from the user's explicit purpose and what is clearly determinable, and you must not let extra people, props, backgrounds, text or poses in the reference image overstep into the story.
- When the user explicitly says "position reference only / costume reference only / product reference only" and so on, keep that "only" restriction in the simple label, e.g. "blocking reference only", "costume reference only".

**Conflict handling:**
- When the user's text settings conflict with a reference image, apply the story-fact source priority of A0.1.1; the user's latest explicit text change prevails.
- When multiple reference images conflict with each other, do not merge them into a new setting yourself; use each according to the user's explicit purpose.
- Extra people, props, text or decorations in reference images that the user did not mention are not brought into the story automatically.

**Recommended 2.5 Reference binding format:**
```text
Reference binding:
- {{node/image-xxxx}}: Hayashi Naoto character reference
- {{node/image-yyyy}}: Old House Living Room scene reference
- {{node/image-zzzz}}: Plum Wine Bottle prop reference
- {{node/image-aaaa}}: blocking reference only
```

The node form in the example above only indicates **format and placement**; at runtime it must be replaced with the complete node IDs / asset handles that the user actually provided and that this segment actually needs; do not copy or invent the example IDs. If this segment has no real reference image / asset handle at all, omit the whole section.


### A1.3 On-screen text: post-production subtitles vs. physical asset text

Two kinds of text must be distinguished:

**A. Post-production text (by default, never handed to the generation model)**
- Subtitles, titles, caption cards, narration cards, sticker copy, UI overlays, watermarks
- By default write: **no subtitles, no extra on-screen text, no post-production text overlays**
- If such text is needed, leave it to post-production editing by default

**B. In-story physical text / product asset text (not subtitles)**
- Existing printing on packaging bags, signboards, letters, book pages, phone screens, etc.
- If the user provided reference images/asset images: prefer writing "**strictly keep the reference asset's appearance; do not add, rewrite or redraw the packaging text**", and do not ask the model to generate clear text from nothing
- If there is no reference asset: unless the story must read specific text, do not make "text must be clear and legible" a generation task
- Only lock text word for word when the user explicitly requires that a segment must read it; at the same time, note that this is a high-risk generation item

**Therefore:** "no subtitles / no extra on-screen text" does not conflict with "existing text on product packaging". What is forbidden is the AI adding or rewriting text on its own, not turning real packaging into text-free packaging.

---

## A2. Full beat parsing and order preservation (no story filtered out)

The goal of A2 is not to "pick a few key points" but to break the original story into **complete, continuous, timeable narrative beats**. The five key-beat categories are only tags, not a cut threshold.

### A2.1 Atomic beats: keep them all and build a "source-story ledger"

First break the story into atomic beats in original order. Common types include:

| Atomic beat | Definition | Examples |
|---|---|---|
| **Dialogue** | A complete line, or a group of consecutive lines, a character actually speaks | Question, answer, interruption, addition |
| **Action** | An action that changes position / an object / body state | Pick up, put down, stand up, walk to the door |
| **Reaction** | Feedback caused by the previous event, not necessarily spoken | Cup stops, flinches back, looks at wrist, silence |
| **Information** | The audience/a character gains a new fact | Sees something, recognizes the product, discovers a wound |
| **Transition / pause** | A spatial, temporal or emotional transition the user's original explicitly asks for | Empty shot, ambient sound, pause, scene transition |

**Register every atomic beat.** Ordinary actions that are not a "climax/turning point" must not disappear because of that.

Internally number each source beat `E01 / E02 / E03 ...`, recording at least:
- who performs / speaks the original event;
- what the action or dialogue is;
- what its target / prop is;
- its original order relative to adjacent events;
- whether the user explicitly gave facts such as time, position, quantity, left/right hand or prop origin.

Every sentence in each later Timeline that **changes story state** must map back to an `E##`. Content without an `E##` is allowed only for: cinematography, composition, visible results of lighting, physical details/foley directly corresponding to existing actions, and execution descriptions that do not change story facts.

**If a sentence changes a character, prop, position, quantity, relationship, information or causality but has no corresponding source beat → treat it as AI-added story and delete it.**

### A2.2 Five key tags: mark importance only, never change order

Add tags on top of the atomic beats:
- **Turning point**: a reversal in relationship / power / information
- **Emotional peak**: the strongest emotional leak in this segment/scene
- **Information gain**: new information changes understanding
- **Decision point**: a character makes a choice and bears the consequences
- **Silence point**: meaningful silence after build-up

**Hard rules:**
- Tags may overlap; one beat can belong to several categories.
- Beats without any key tag are still kept.
- **Never "sort the story by emotional curve".** The emotional curve can only be annotated in the original story's chronological order: low → pressure → peak → release; it is an analysis chart, not a re-editing instruction.

### A2.3 Budget time for each beat first

Estimate the minimum natural duration of each atomic beat:

`beat minimum duration = natural dialogue time + necessary pauses + action/reaction time that must happen in sequence`

Note:
- "Talking + small actions" that can naturally happen at the same time may overlap in timing;
- causal actions that must happen one after another must be added together;
- long dialogue cannot be crudely treated as "a long line always takes 3–3.5s"; estimate natural reading time from actual text length, pauses and tone;
- when unsure, leave roughly 10%–20% breathing margin rather than cramming with unnaturally fast speech;
- key pauses, reactions, turns and movement must not be swallowed entirely by dialogue.

### A2.4 Beat → shot → generation segment

Only merge beats that are **adjacent in time**; do not splice across intervening story. **Merging segments only changes how beats are carried; it does not change any `E##`'s content, performer, target, order or quantity. One source beat may be shown across several shots, but it cannot be rewritten into a different event.**

A segment may hold several beats, but "1–4 beats" is only a rule of thumb, not a hard cap. Whether to keep merging depends on these conditions:
1. total duration after merging ≤ the model's per-segment cap;
2. all dialogue can be finished at a natural pace;
3. key causal actions have their full process;
4. there is still room for necessary reactions and breathing;
5. it does not get so crowded that a cut is forced every 1–2 seconds;
6. the segment can end in a clear state that the next segment can restate.

Start a new segment proactively if any of the following occurs, even if more could theoretically fit:
- dialogue is already near the time-budget cap;
- the segment would need too many competing actions/reactions;
- there is a clear phase change in emotion or goal;
- the scene/time changes;
- further merging would break the independent generatability between segments;
- fitting it in would need unnaturally fast speech, teleporting actions or omitted reactions.

### A2.5 Batching long stories

**Finish planning all segments of the film first, then deliver in batches.**

For example, a 180s episode:
- Seedance 2.0 needs at least 12 segments in theory, but dialogue density may actually make it 13, 14, 15… segments;
- fix the global segment numbers first as G01, G02, G03…;
- then deliver at most 6 segments per batch: Batch 1 = G01–G06, Batch 2 = G07–G12, Batch 3 = the remaining segments;
- likewise for Seedance 2.5, with at most 3 segments per batch.

**Batch boundaries only affect how many segments are output at once; they do not change the film's order, segment numbers or continuity.**

### A2.6 Fallback

If the story has no obvious turning point/peak, do not force the five key-point types. Keep planning in original order, using "one fully executable action/dialogue/reaction unit" as the beat.

---

## A3. Segmentation and duration budget

### A3.0 First distinguish the "theoretical minimum segment count" from the "actual segment count"

**Per-segment hard caps:**
- Seedance 2.0: each segment ≤ 15s
- Seedance 2.5: each segment ≤ 30s

When the user gives a strict total duration, you may first compute the theoretical minimum segment count:

```text
theoretical minimum segments = ⌈total duration / per-segment cap⌉
```

This formula only answers "how many segments are needed at least"; it **does not mean you must make only that many**.

Example: 55s / Seedance 2.0:
- theoretical minimum = 4 segments;
- if the dialogue/action is light, you can do 15 + 15 + 15 + 10;
- if the story is dense, you can also do 12 + 11 + 11 + 11 + 10 = 55s;
- either works as long as each segment is ≤ 15s, the total matches the user's total duration and the story is complete.

**Principle: balance "not overcrowded" against "not fragmented", rather than chasing the fewest segments.**

### A3.1 Order for determining the actual segment count

Decide in this order:
1. first complete A2's full beats and minimum duration budget;
2. merge adjacent beats from front to back;
3. each time you approach the per-segment cap, check whether dialogue, actions and reactions are still natural;
4. if not, cut early and start a new segment;
5. obtain the **film's actual segment count**;
6. only then split into Batches per A3.4.

Do not decide "it must be 4 segments" first and then force the story into 4 segments.

### A3.2 Dialogue duration check (hard threshold)

Every line of dialogue must genuinely be speakable within its shot/time window.

How:
- first simulate the reading time in natural speech;
- then add the pauses, stutters, gasps and hesitations the script explicitly calls for;
- small actions that can run in parallel with speech may overlap;
- actions that must finish before/after the line take their own time;
- **do not solve a lack of time with unnaturally fast speech;**
- **do not delete or change words or swallow line endings because time is short.**

If the user's "strict total duration" conflicts with the minimum natural duration of "all original lines + required actions":
- first compress the empty shots, information-free pauses and redundant camera moves **that the AI itself added**; empty shots, pauses and silences the user's original explicitly requires must not be compressed or deleted;
- if it is still not enough, explicitly mark "duration constraint conflict" in the full-film overview;
- do not delete lines or change the story on your own to pretend the constraint is met.

### A3.3 How to write the timeline

- Each segment's timecodes restart from `00:00`, so it can be fed to the model on its own;
- the full-film overview separately records the segment's **global time range**;
- action timecodes within a segment must not contradict each other;
- parallel actions may overlap in time windows, but say "simultaneously" explicitly;
- sequential actions must follow on from each other; do not finish several actions that cannot happen simultaneously in the same second.

### A3.4 Long stories and per-batch capacity

**Per-batch delivery cap (a capacity limit, not a cap on the film):**
- Seedance 2.0: at most 6 segments per batch
- Seedance 2.5: at most 3 segments per batch

When exceeded:
- keep the film's segment numbers continuous;
- only split into multiple Batches;
- do not renumber earlier segments;
- do not call undelivered content "cut"; consistently call it "segments pending in the next batch".

A 2–3 minute story may well have 2, 3, 4 or even more batches.

### A3.5 Shot density per segment (recommended, not a hard cap)

- Seedance 2.0: usually 1–2 main shots; 3 when the content is very light, but avoid choppy cutting
- Seedance 2.5: usually 2–4 main shots

If a segment needs constant high-frequency HARD CUTs to hold its story, prefer splitting the segment over adding more shots.

### A3.6 General prohibitions and text rules

Forbidden by default:
- no dissolves, flash-whites or whip pans, and no speed changes without a story basis;
- no VO, narration or lines the user did not provide;
- no automatically added BGM or emotional cue sounds;
- no new characters, new props or new story actions;
- **no post-production subtitles, titles, caption cards, UI overlays, watermarks or other extra on-screen text.**

But physical in-scene text / product packaging text follows A1.3:
- with a reference asset, keep the reference appearance; do not add, rewrite or redraw;
- do not misread "the packaging must appear" as "ask the AI to generate clear, accurate text".

---

## A4. Asset and on-screen status planning (written along the timeline)

A4 is an **internal planning rule** shared by all models. If a character's on-screen status differs across time blocks/shots within the same segment, register each one along the timeline; do not write a single vague overall status.

**A4 supplement · Design proposals when appearance or lighting is missing**

When the script / user has not provided a character's appearance, or a scene's lighting and environmental tone are missing, but the episode's visuals genuinely need them:
- you may derive a "design proposal" using Toonflow's visual design / color and lighting methods (visualDesign / colorAndLight) and fill it into this segment's identity + appearance anchors or scene lighting;
- every proposal is labeled "design proposal" and is not treated as story fact; do not use it to add story, prop origins, character relationships or world rules;
- if it does not affect this segment's generation, keep the original level of abstraction and do not force a design (per A0.1.5).

**Mapping to final output:**
- Seedance 2.0: still explicitly output "asset identification" before each segment's body.
- Seedance 2.5: do not output a separate, repeated "asset identification" block; map A4 information into `Reference binding`, `Immutable locks`, `Timeline` and `Preserve` respectively. Output a separate asset list only when the user explicitly asks for one.

Internal planning may use the format below:

```text
## Asset identification

### Characters involved

Character A｜On-screen status overview
- Time block / Shot 1｜00:00–00:XX｜hands only / actually on screen / fully off-screen…｜speaking / not speaking
- Time block / Shot 2｜00:XX–00:XX｜……

Identity + appearance anchors: cite only information the user has given.
World coordinates: write only neutral spatial relationships already fixed by the source story or required for generation.
Frame coordinates: describe them for the current camera position, without changing world-position facts.
Special states: register only dirt / injuries / wetness / held items already in the source story.
Key performance in this segment: make existing story actions visible; add no actions.
Synchronous lines kept strictly as in the original:
「……」

Character B｜On-screen status overview
- Time block / Shot 1｜00:00–00:XX｜fully off-screen｜synchronous dialogue only
- Time block / Shot 2｜00:XX–00:XX｜actually on screen｜not speaking
……

### Scenes involved
Scene A｜time
(scene anchors + camera position/direction/height + foreground/midground/background + spatial relationships)

### Key props
Prop A
(start-of-segment state given by the source story + timeline actions already in the source story + end-of-segment state + how text/packaging is handled; do not trace unstated origins)
```

### A4.1 On-screen status vocabulary for characters

Choose according to each shot's actual visible range:
- On screen and speaking
- On screen, not speaking
- Partial face only
- Hands only
- Over-the-shoulder only
- Back only
- Feet only
- Fully off-screen｜synchronous dialogue only
- Fully off-screen｜no sound

**If a character has two or more statuses within one segment → list a timeline.**

### A4.2 Character entries must include 6 kinds of information
1. Identity + appearance anchors
2. Per-shot on-screen status timeline
3. World coordinates + frame coordinates
4. Special states (those that change in this segment: dirt / wounds / wetness / visible emotion, etc.)
5. Key performance in this segment + 3–5 visible performance requirements
6. Original text of synchronous lines (if any)

### A4.3 Scene entries must include 4 kinds of information
1. Scene anchors
2. Camera position + direction + height
3. Foreground / midground / background
4. Spatial relationships and axis between characters/landmarks

### A4.4 Prop entries must include 4 kinds of information
1. Absolute position / user / state at segment start
2. Timeline actions in this segment (who, when, how it moves)
3. State at segment end
4. Prohibitions; if there is packaging text, note per A1.3 "keep the reference asset; do not add/rewrite/redraw text"

### A4.5 Forbidden
- Do not copy whole character profiles; keep only the anchors this segment needs
- Do not write assets that do not appear
- Do not turn asset identification into a retelling of the whole story
- Do not use contradictory summaries such as "actually on screen and speaking in this segment (but off-screen in Shot 1)"
- Do not ask the AI to generate exact packaging text from nothing in place of the reference asset

---

## A5. Blocking: world coordinates + frame coordinates (two layers · self-contained)

**Core premise: when each segment is generated, the model cannot see any frame of the previous segment and does not rely on the previous segment's last frame as a reference.**

### A5.1 Five blocks of information every segment must contain on its own

1. **World coordinates · axis and landmarks**: the characters' real positions relative to doors, tables, windows, corridors, etc.; independent of camera position.
2. **Frame coordinates · left/right / front/back / occlusion in the current shot**: restated for the current camera position.
3. **Light direction · world layer + frame layer**: inherited only under the same continuous lighting conditions.
4. **Absolute prop positions and states**: including movement paths in this segment.
5. **End state of this segment**: the next segment must rewrite it as an "absolute initial state", not write "continues from the previous segment".

### A5.2 State chain for continuous scenes

Within the same location and the same continuous time:

`previous segment's end state → rewritten as the next segment's absolute initial state → this segment's actions → this segment's end state`

Inherited content includes:
- characters' actual world positions and body orientation
- prop positions, holders, quantity, liquid level, stains/wear
- persistent states such as injuries, costume, wetness, blood, smoke and dust
- key light direction, color temperature and environmental conditions

### A5.3 Character movement follows only the source story; never add actions for continuity

What is forbidden is the AI creating unfounded position changes, and also adding story in reverse to "explain a position change".

- Original explicitly says "stands up and walks to the door" → keep the standing up, walking and arriving; no teleporting.
- The original's next beat directly says "the character is already standing at the door" without saying how they got there → treat "standing at the door" as that beat's given initial state and allow entering it via HARD CUT / a new segment; **do not add "stands up, walks over" yourself.**
- Original explicitly says the two swap places → execute the process as the original says; original does not mention a swap → do not swap the two characters' world positions for composition.
- Frame left/right may change through a legitimate camera change, but world positions must not change without a source.

### A5.4 Axis rules

- A continuous conversation keeps the established 180° axis by default;
- if the user explicitly asks for a reverse shot / crossing the line, or the story needs the axis to change, make the spatial change readable via a neutral camera position, a move across the axis or an establishing shot;
- unsignaled axis jumps are forbidden;
- **"don't cross the axis" does not mean the camera can never change position.**

### A5.5 Re-anchor on scene changes / time jumps

When the scene, time, weather or main light source clearly changes:
- the new scene re-establishes world coordinates, frame coordinates, axis and lighting;
- do not force inheritance of the previous scene's camera positions or light direction;
- whether costume, injuries, carried props, etc. are inherited depends on the story's time continuity.

This supports multi-scene stories of 2–3 minutes or longer without locking the first scene's blocking rules onto the whole episode.

---

## A6. Performance layer

### A6.1 Emotion = a by-product of behavior
Don't write "he is sad"; write **what he is doing**. Emotion leaks through small deviations in action.

### A6.2 Goals point at targets
Only when the user's original story already makes a character's goal clear, organize it into an executable goal pointing at a specific person / object / task. **Do not infer a character's motive, hidden purpose or relationship intent yourself for the sake of a complete performance.**

### A6.3 States first, but key causal actions must keep their process
Key causal actions (taking / putting down / pouring liquid / opening a door / switching hands / sitting down / standing up / moving) cannot teleport.

### A6.4 Micro-expressions need a source-story basis + trigger
Micro-expressions are allowed only when the source story already has a corresponding reaction / visible emotion, written as `[visible micro-expression of an existing reaction] + [original trigger condition]`. **Do not add new reactions such as frowning, pursing lips, blushing, swallowing or a wry smile just because the shot is close.**

### A6.5 mask + crack (only when the source story supports it)
- **mask**: only organize the surface state the user has already given; do not assign a character a "disguise" yourself.
- **crack**: only make a reaction the user already has concrete as one visible slip; add no reactions.
- Do not stack several cracks in a row in the same shot; when the source story has no crack, you can skip it entirely.

### A6.6 Performance channel adaptation (must be written)

| Visible in shot | Main performance channel |
|---|---|
| Face visible | Eyes + very small facial changes |
| Hands only | Grip + action rhythm + touch |
| Back visible | Center of gravity + shoulders and neck + breathing |
| Feet visible | Gait + weight transfer |
| Full-body wide shot | Posture + occupation of space |

**Write only the performance channels actually visible in this shot.**

### A6.7 Timing of reactions relative to lines
A reaction may start before the other person's line ends, but it must have a clear trigger word/trigger action; do not mechanically require "all reactions wait until the line ends" or "all reactions come early".

### A6.8 Restrained outbursts
Strong emotion may subtract from **performance embellishments the AI added itself**, e.g. one fewer extra frown, one fewer unnecessary sigh; **it must not delete, replace or delay the user's original story actions/lines/reactions.** Restraint may be expressed with lighter amplitude and shorter performance events, but the story events themselves must remain exactly as they are.

### A6.9 Number of micro-expression events (a reference cap, not a minimum quota)
- ≤15s segment: usually no more than 1–2 micro-reactions already in the source story
- 16–30s segment: usually no more than 2–3 micro-reactions already in the source story

**Zero is completely allowed. Do not add micro-expressions to reach a number.** If the shot only shows hands/back, do not force facial micro-expressions.

---

## A7. Camera movement and transitions between segments

### A7.1 Emotional curve

```text
low ──→ mid ──→ high ──→ release
start   pressure  peak     landing
```

The emotional curve is recorded in the original story's chronological order and cannot be used to reorder the story.

### A7.2 Emotional position → camera movement
Peaks can be inner, information reversal or external action; camera movement must follow the user's specified style and must not automatically push in or go to an extreme close-up just because it is a "peak".

### A7.3 Transition rules between segments (independent generation first)

**Scope of judgment: only "the last shot of segment N" and "the first shot of segment N+1".**

Shot attributes come in three kinds:
- **Subject**: two-shot / single / partial / empty shot / group
- **Shot size**: full / medium / medium close-up / close-up / extreme close-up
- **Angle**: front / side / back / over-the-shoulder / high angle / low angle

To keep two independently generated segments from looking like a mistaken frame continuation at the edit point, a transition between segments should by default satisfy at least one of:
1. a different subject type;
2. shot sizes at least 2 steps apart;
3. camera angles at least 90° apart.

When none of the three holds, you may only adjust the **subject/shot size/angle/composition** of the next segment's first shot; you must not change the source story event, character position facts, actions, props or dialogue of that first shot.

**Recommended:**
- two-shot medium → single/partial close-up
- two-shot medium → empty shot
- single medium → two-shot medium
- partial close-up → two-shot medium
- empty shot → two-shot medium
- single side medium → single front close-up

**High risk:**
- same subject + same shot size + similar angle directly across segments
- the same hand action hard-joined across two independently generated segments

Note: there is no second rule such as "partial → partial is always forbidden" that conflicts with the three conditions above. If subject/shot size/angle already differ enough, it is usable; but continuity must still be easy to read.

### A7.4 Action-continuity cuts

A match-on-action for the same unfinished action is **preferably kept within one generation segment**:
- shot A's last frame is mid-action;
- HARD CUT;
- shot B's first frame completes it.

When crossing generation segments, prefer letting the previous segment complete the action and having the next segment restart from "the stable state after the action is done", to reduce discontinuity between generations.

### A7.5 Style routing table

| Style | Camera movement | Performance | Lighting | Sound |
|---|---|---|---|---|
| **Restrained** | Mostly locked-off / may stay still even at the peak | Emotion leaks through deviations in action | Natural light / low contrast | Ambient sound dominates |
| **Suspense** | Mostly stable camera / sudden reverse shot when needed | Information gap at the core / reactions may lag half a beat | Hard shadows / side-back light | Silence can be more effective than music |
| **Comedy** | Locked-off / wide-shot freezes often work | Characters play it straight; contrast creates the humor | Even, normal light | Ambient sound dominates |

When the user has a clear style, the user's style has the highest priority.

---

## A8. Cross-segment continuity check (determine the relationship first, then verify)

A7.3 is the **only rule source for shot-type changes between segments**; A8 is responsible only for continuity of characters, props, environment and persistent states. **Do not force every pair of adjacent generation segments into one continuous space. First determine whether two segments really have a continuity relationship, then decide what to inherit.**

### A8.1 First determine the continuity relationship of adjacent segments

For every `segment N end state → segment N+1 initial state`, internally mark exactly one of the following three:

1. **Continuous**: same location and same continuous time, or the source story explicitly says "continues / then / follows on / same round of conversation / same action chain"; the next segment's initial state depends on the previous segment's end state.
2. **Partial-state link**: the scene or time has changed, but the source story explicitly requires some persistent states to continue, e.g. the same carried prop, damaged costume, injuries, wetness, stains, remaining product, etc. Inherit only these persistent states, and **do not force inheritance of the previous scene's character positions, camera positions or frame left/right**.
3. **No continuity / re-anchor**: the scene, time or narrative unit has switched, and the next segment does not depend on the previous segment's character positions or prop end states. Only check whether this segment's own start state, actions and end state make sense; character positions, camera positions and lighting are re-established for this segment.

The judgment is based only on the user's latest explicit instructions, the source script and confirmed states. **Do not invent a link yourself "so that it connects".** If the source story directly gives a new state for the next segment without a transition, treat that state as the new initial state per A0.1.4 and enter it via HARD CUT / a new time block, without adding movement or handover backstory.

### A8.2 Character position check (mandatory for continuous segments)

For every character that actually has a continuity link, maintain a concise internal state chain:

`absolute position/pose at segment start → source story action → absolute position/pose at segment end → absolute initial position/pose in the next segment`

Check at least:
1. **World position**: whether the position relative to landmarks such as doors, tables, windows, corridors, vehicles and fixed furniture is consistent;
2. **Relative positions of characters**: whether who is on which side of whom, front/back distance, and being separated by a table/door/counter have changed without reason;
3. **Body state**: whether standing / sitting / crouching / lying, body orientation and whom they face are continuous;
4. **Hand occupancy**: if a character is holding a key prop, whether that hand/both hands are still occupied by that action; when the source does not lock left/right hand and the shot does not need it, do not force one, but once it has been made explicit for execution, the hand cannot switch without process in related shots;
5. **On-screen and off-screen**: framing or a camera change can move a character from on-screen to off-screen, but that does not mean the character disappears or moves in world space;
6. **Basis for movement**: when a position changes, it must correspond to an existing move/stand-up/sit-down/turn event in a source-story `E##`, or to a new initial state given directly by the source story; without a basis, a cut cannot make a character teleport.

**Frame left/right may change through a legitimate camera change, but world position cannot change because of it.** For a reverse shot, check world coordinates first and then recompute frame coordinates; do not secretly move characters to keep them "always frame left/right".

### A8.3 Prop state chain check (mandatory within a segment + across continuous segments)

For key story props, products and small objects that take part in actions, internally maintain:

`holder / hand used (if specified) / absolute position / visible or occluded / quantity / open-closed state / contents or liquid level / stains, wetness, wear / actions in this segment / end-of-segment state`

Hard rules:
- If someone was holding a pen across continuous shots and the source story has no "put down / hand over / put away / drop / leave frame" event, it **cannot vanish from nowhere** a moment later;
- if the next shot crops out the hand or prop, or it is occluded by a body/furniture, "temporarily not visible" is allowed, but its world state stays the same; **do not treat "not filmed" as "the prop disappeared"**;
- if the same hand holding the item is still clearly visible in the next shot and there is no state-change event, the prop should still be in the hand;
- a prop that was put down cannot return to the hand without process, and a prop already given to B cannot also appear in A's hand in the next shot;
- quantity, size, form, color, opening mechanism, liquid level, wear and stains cannot be duplicated, restored or changed without cause;
- a prop entering or leaving the frame edge is not a prop state change, unless the source story actually moved it.

### A8.4 Scene and physical environment continuity

Check only for "continuous" or "partial-state link":
- doors and windows opened/closed, chairs/tableware/furniture already moved;
- persistent states such as water on the floor, stains, damage, smoke and leftover food;
- key light direction, time, weather and whether actual light sources are on;
- mirrors, glass and reflective surfaces must not show extra copies that contradict the current character/prop state;
- characters must not clip through the fixed environment, pass through walls or cross closed barriers without basis.

### A8.5 Limits of cross-segment fixes

When you find a continuity problem, you may only:
- fix textual conflicts in world/frame coordinates;
- fix on-screen/occlusion descriptions;
- fix key props' holder, visibility and state locks;
- adjust shot carrying, shot size or cut points so existing actions are shown more completely;
- when necessary, re-break shots/segments at **existing `E##` boundaries**.

**Do not add bridging actions the user did not write, such as "put the pen down / pick it up again / walk to the other side / take a new one", to fix continuity.** If the conflict comes from the source story itself, mark "source-text conflict" per A0.1.6 and do not fix it into a different story.

**Do not write "same as above" or "keep the previous segment's blocking". A segment that inherits must rewrite the inherited result as an absolute initial state; segments without a continuity relationship only check themselves.**

---

## A9. Segment prompt templates (routed by model)

A9 defines only the **final delivery shell**; it does not change any execution logic of A2–A8.

- Seedance 2.0 → use A9.1
- Seedance 2.5 → use A9.2

If A9's wording conflicts with the execution rules of A2–A8 or A11–A12, the execution rules prevail.

### A9.1 Seedance 2.0 segment prompt template (asset identification + formal prompt)

```text
═══════════════════════════════════════════
G0N｜Batch X / Segment N ｜Target model: Seedance 2.0 ｜Segment duration: Xs ｜Global time: MM:SS–MM:SS
═══════════════════════════════════════════

## Asset identification

### Characters involved
Character name｜On-screen status overview
- Shot N-1｜00:00–00:XX｜hands only / actually on screen / fully off-screen…｜speaking / not speaking
- Shot N-2｜00:XX–00:XX｜……
(identity + appearance anchors + world coordinates + frame coordinates + special states + key performance in this segment + performance requirements + original synchronous lines)

### Scenes involved
Scene name｜time
(scene anchors + camera position, direction and height + foreground/midground/background + spatial relationships)

### Key props
Prop name
(absolute position at segment start + timeline actions + end-of-segment state + prohibitions; packaging text per A1.3)

─────────────────────────────────────────
【Formal prompt】

Generate a live-action cinematic short with a total duration of exactly Xs.
(visual style / camera overview / light source overview)

## Character spatial relationships
(world coordinates + frame coordinates · two layers; never write only "continues from the previous segment")

## Shot N-1｜00:00–00:XX｜XXs｜subject + shot size + angle
Camera and composition: ……
First-frame lock: ……
Action timeline: ……
Performance: ……
Physics: ……

## 00:XX｜HARD CUT

## Shot N-2｜00:XX–00:XX｜XXs｜subject + shot size + angle
……

## Lighting
(key light world direction + frame direction + exposure logic + continuity with the previous segment/shot)

## Sound
(real ambient sound + original synchronous dialogue; whether there is BGM follows the user's requirement)

## Positive locks
(absolute character positions / prop holding / eyelines / continuous states / characters who must not appear in this shot)

## Text lock
No subtitles, no extra on-screen text, no post-production overlays; physical packaging/signboard text only keeps the reference asset, with nothing added, rewritten or redrawn.
```

### A9.2 Seedance 2.5 segment prompt template (Objective structure)

Seedance 2.5's final delivery uses a more compact structure that can be fed directly. **Do not repeat a full A4 asset identification block before each segment.** A4's information must already be packed into `Reference binding`, `Immutable locks`, `Timeline` and `Preserve`.

#### A9.2.0 Final format hard gate (mandatory)

When the target model is **Seedance 2.5**, the final delivery may only use the field structure of this section, A9.2. Apart from the segment header, the only allowed top-level fields are:
- `Objective`
- `Reference binding` (appears only when real reference assets exist; omit the whole section when there are none)
- `Immutable locks`
- `Target duration`
- `Timeline`
- `Visual direction`
- `Audio direction`
- `Preserve`
- `Avoid`

**Do not deliver any intermediate planning draft, another model's template or a non-A9.2 shell directly as the 2.5 final delivery.** Apart from the segment header and the whitelisted fields above, the 2.5 final body must not contain any other top-level field, numbered shot-breakdown sections or extra analysis blocks.

The 2.5 final `Timeline` must, per A9.2.1, use `【0:00-0:XX】` time blocks + continuous natural language. Shot changes, where truly needed, may only be embedded in the natural language of the corresponding time block; do not set up a separate shot-numbering system as the main structure.

If the internal draft or upstream input uses another structure, treat it only as **source material**, never as the final template: first parse it per A0–A8/A11, then rearrange it into the A9.2 whitelisted fields before delivery. Whenever the final body contains top-level structure outside the whitelist, it counts as a format failure: **do not deliver; rewrite it directly into A9.2 in this round**.

```text
═══════════════════════════════════════════
G0N｜Batch X / Segment N ｜Target model: Seedance 2.5 ｜Segment duration: Xs ｜Global time: MM:SS–MM:SS
═══════════════════════════════════════════

Objective:
In 1–2 sentences, state this segment's place in the episode, its duration/aspect ratio/overall look, and the core dramatic goal this segment must achieve. Do not restate the full Timeline.

Reference binding:
- Automatically read and analyze this segment's story, shots, actions and visual content, and extract from them the reference assets this segment actually involves and needs to call, including character images, scene images, product images, prop images, blocking images, etc.
- Give each extracted asset a simple label that only states the object or use it corresponds to, e.g. "male lead character reference", "inn scene reference", "product packaging reference", "red string prop reference".
- Every real reference image or asset handle the user has provided and this segment actually needs must be listed one by one, keeping its node ID, asset handle or other reference identifier exactly as is; do not rewrite, abbreviate or renumber it.
- Even if a reference asset was used in the previous segment, as long as this segment still involves it, it must be extracted and listed again in this segment; do not use shorthand such as "same as above" or "reuse the previous segment's reference".
- Extract only assets this segment actually involves; do not mechanically add assets that do not appear in this segment's story or visuals.
- There is no need to explain in detail what each reference image "controls / doesn't control"; a concise, clear asset identity label is enough.
- If this segment has no real reference image, node ID or asset handle at all, the whole section can be omitted.
- Never invent {{node/image-...}}, asset numbers, reference tags or nonexistent reference material from the story.

Immutable locks:
- Write only immutable conditions that directly affect generation stability: character identity/costume, key world positions and left/right relationships, lighting logic of continuous scenes, key prop states, product structure, original dialogue and lip sync, necessary off-screen locks, etc.
- Do not copy the whole segment's story again.
- When a continuous scene crosses segments, rewrite the previous segment's end state as this segment's absolute initial state; do not write "continues from the previous segment".

Target duration: X seconds

Timeline:
【0:00-0:XX】Describe, in one continuous passage of natural Chinese, what is actually seen in this time block: necessary scene/blocking, current on-screen status, shot size or cuts, order of actions, key performance reactions, synchronous dialogue, key prop changes and necessary physical details. Write it like a description of the finished film; do not split it into sub-headings such as "camera / action / performance / lines / physics".

【0:XX-0:XX】Continue describing the following visuals in one continuous natural-language passage.

【0:XX-0:XX】Continue as the story requires; the number of time blocks is not fixed.

Visual direction:
In 1 compact paragraph, summarize the overall cinematographic look, lighting, color temperature, depth of field, visual relationships of characters/products and necessary physical textures. Write only visual requirements that really affect this segment.

Audio direction:
- Physical foley / ambient sound: ……
- Dialogue voices: ……
- Write a score only when the user explicitly asks for one; when not asked, default to "no background music; keep only real synchronous sound and ambient sound".

Preserve:
In one line or a short paragraph, list the character looks, scene anchors, product structure, key prop states, spatial relationships or action logic that must be kept.

Avoid:
In one line or a short paragraph, list the problems most likely to go wrong that are directly relevant to this segment; do not pile up a long list of generic negative terms.
```

#### A9.2.1 How to write the Timeline (mandatory)

`Timeline` must follow the style of the user's usual finished Seedance 2.5 prompts: **time blocks + continuous natural-language visual description**.

Correct illustration:

```text
Timeline:

【0:00-0:06】
In the scene the source story has already established, Character A performs E01's original action. The shot cuts as needed from an establishing shot to a medium shot of Character A; if Character B stays off-screen in this beat per the original, state explicitly "Character B stays off-screen". Add only directly visible posture, contact and physical feedback; do not add events the source story lacks, such as taking, opening a lid or moving.

【0:06-0:12】
Carries E02–E03. Character A says the line as in the original, and Character B gives the existing reaction as in the original. The existing reaction may be written as a concrete visible action, but the "reaction" must not be expanded into new story behavior. Cut to a medium close-up or partial close-up when necessary; the order of story events stays the same.

【0:12-0:18】
Carries E04. If the source story already sets a prop in the character's hand at this time block's first frame, start directly from that state, without tracing or writing how the prop got into the hand. The camera only presents; it does not fill in backstory.
```

**Execution requirements:**
- Each time block is usually 1 paragraph; enough information is enough.
- The number of time blocks is decided naturally by the story, not fixed at 3 or 4.
- You can write "cut to male lead medium close-up / cut to hand close-up / back to two-shot medium" directly, without setting up shot numbers.
- Write only the blocking, left/right, off-screen states and continuity that actually affect the current time block; do not mechanically repeat `Immutable locks`.
- When a character should not appear, briefly writing "female lead stays off-screen; do not automatically add her into the shot" is enough.
- Embed lines directly where the corresponding action happens; do not repeat them again after the Timeline.
- Write only physical details directly related to the current action, such as liquid sloshing, fabric contact, wet prop surfaces, object weight and collision feedback.
- Each time block preferably keeps one clear action chain; do not cram every second for the sake of complete information.
- **The focus is "what the finished film actually shows at this moment", not re-explaining rules.**
- Every action in the Timeline that changes characters/props/positions/quantities/relationships/information must come from an A2 source beat `E##`.
- Do not add taking, opening/closing, pulling out, handing over, standing up, moving, looking back, number of uses, prop consumption or other behavior the source story lacks to make it "smoother", "more complete" or "more causal".
- If the source story starts directly from a given state, write that state directly; do not question or add how it came about.
- When the original uses generic terms such as "parents / guardian / adult / someone", the Timeline keeps the same generic term, unless the user's latest explicit instruction has specified a particular person.

#### A9.2.2 Reference binding (2.5 hard rules for real reference assets)

- Automatically read this segment's story, shots, actions and visual content, and extract only the real character, scene, product, prop, blocking, action and other reference assets that **this segment actually involves and needs to call**.
- Reference only reference nodes, image tags or asset handles the user actually provided, and **keep the complete node / handle exactly as is**; do not rename, abbreviate, renumber or invent nonexistent references from the story.
- List each real reference on its own line in the form "**real node / handle: concise asset label**"; the label only states the object or use it corresponds to, e.g. "male lead character reference", "inn scene reference", "product packaging reference", "red string prop reference".
- You are not required to expand a long "what it controls / doesn't control" note for each image; but internally you must still follow the user's explicit purpose, and must not let a character image overstep to change blocking, a blocking image override character identity, or a scene image bring in extra people or props.
- When the user explicitly says "position reference only / costume reference only / product reference only" and so on, the concise label must keep the use restriction, e.g. "blocking reference only", "costume reference only".
- **Each segment is self-contained**: a reference already used in the previous segment must be listed again when this segment still needs it; do not write "same as above" or "reuse the previous segment's reference".
- List only the assets this segment actually needs; do not mechanically stuff the whole episode's reference library into every segment.
- When there are no real references, omit the whole `Reference binding`; do not fake `{{Ref}}`, `{{node/image-...}}`, asset numbers or nonexistent asset names.

#### A9.2.3 Immutable locks

Keep only information that **must not drift**, e.g.:
- male lead in white, female lead in red;
- female lead on the south side of the table / frame left, male lead on the north side of the table / frame right;
- the product's blue flip-top structure;
- a character stays off-screen in a given time block;
- original lines unchanged, no swallowed words;
- lighting direction and prop states in a continuous scene do not reset.

Do not turn every action into a lock; actions that change within the Timeline belong in the Timeline.

#### A9.2.4 Audio direction

- User explicitly asks for BGM / a score → write it as the user asks.
- User did not ask → by default no BGM and no emotional cue sounds; keep only real ambient sound, physical foley and synchronous dialogue.
- Do not make a score the 2.5 default just because one appeared in an example.

#### A9.2.5 Preserve / Avoid

`Preserve` and `Avoid` must serve the current segment's execution:
- `Preserve` lists the looks, space, product, props and action logic that truly must not drift;
- `Avoid` lists the generation errors most likely in the current segment;
- keep both short; do not write dozens of generic tags.

---

## A10. Full-film output structure

Long stories must distinguish "full-film planning" from "current batch delivery". The full-film overview stays in Chinese; each generation segment's body is routed by target model to A9.1 or A9.2.

```text
═══════════════════════════════════════════
Full-film overview
═══════════════════════════════════════════
· Target model: Seedance 2.X
· User's target total duration: (strict / reference / unspecified)
· Per-segment hard cap: 15s / 30s
· Theoretical minimum segments: ⌈total duration / per-segment cap⌉ (lower bound only)
· Actual segments in the film: X segments (set by content density)
· Full-film segment table: G01 … GXX (with each segment's duration + global time range + core beats)
· Batch plan: Batch 1 = G01–G0X; Batch 2 = ……
· Current output batch: Batch X
· Segments pending in the next batch: GXX–GXX (write "none" if there are none)
· Master asset table
· Master reference image table (only for 2.5 when the user actually provided reference images): list each image node / asset handle exactly as is + its use; it serves full-film planning and does not replace each segment's own Reference binding
· Scene/time change table
· World axis of each continuous scene
· Emotional curve in original chronological order
· Key beat tags
· Style
· Camera rhythm map
· Duration constraint conflicts (write "none" if there are none)
· Source-story fidelity status: should be "pass"; if the source text itself has gaps/conflicts, only flag the problem and do not fill in story yourself

─────────────────────────────────────────
If the target model is Seedance 2.0:
[G01] uses A9.1 "asset identification + formal prompt"
[G02] uses A9.1
……

If the target model is Seedance 2.5:
[G01] uses the A9.2 Objective structure directly, without repeating a full asset identification block
[G02] uses A9.2
……
─────────────────────────────────────────
```

**Long-episode rule:** even if only Batch 1 is delivered now, first plan the later global segments and the current batch's place in the film, to avoid logic drifting because each batch is re-segmented.

**2.5 conciseness rule:** the full-film overview explains "why it is split this way"; each segment prompt handles "how exactly this segment is generated". Do not stuff overview content into every 2.5 `Objective` or `Timeline`.

---

## A11. Structural check (the only structural-fix stage before A12)

A11 handles the structural questions "can it be generated, and has the story been squeezed out of shape"; A12 only polishes wording and presentation.

### A11.1 Checklist
- [ ] Has the `E01 / E02 / E03...` source-story ledger been built, with the user's latest explicit instructions / original story as the fact source?
- [ ] Can every event in the final Timeline that changes story state be mapped to some `E##`, with no unsourced new actions?
- [ ] Were no user story events added, deleted, replaced, reassigned or reordered?
- [ ] Were vague roles such as "parents / guardian / adult" not arbitrarily made specific as dad/mom/a second person?
- [ ] Was no backstory traced or added for continuity (prop origins, opening lids/pulling out/taking/moving)?
- [ ] Have all atomic beats been registered in original order, rather than keeping only the five key types?
- [ ] Was the emotional curve not used to reorder the story?
- [ ] Is the theoretical minimum segment count used only as a lower bound, without forcing the actual count to equal it?
- [ ] Is every segment ≤ the model's per-segment hard cap?
- [ ] Does the sum of all segment durations match the user's strict total duration; if both cannot be met, is the conflict explicitly marked?
- [ ] Can all dialogue be spoken completely at a natural pace within its time window?
- [ ] Do sequential actions, reactions and necessary pauses have real time, without teleporting or unnaturally fast speech?
- [ ] For long stories, is there a complete full-film segment table first, with delivery by Batch capacity?
- [ ] Is A4's character on-screen status planned along the timeline and consistent with the final body?
- [ ] Has every pair of adjacent generation segments been classified as "continuous / partial-state link / no continuity", without forcing inheritance onto unrelated segments?
- [ ] For all continuous segments, can characters' world positions, relative relationships, poses, orientation and hand occupancy go from the previous end state into the next initial state without contradiction?
- [ ] Have all key props passed the "holder / position / quantity / state / visibility" chain check, with no unsourced disappearance, duplication, hand switch, restoration or teleport?
- [ ] Are changed doors/windows, furniture, stains, liquid levels, damage, weather and light-source states in the scene reasonably inherited in the relevant segments?
- [ ] Has the generation-stability pre-check been done, avoiding cramming high-risk body/hand/prop interaction, complex camera movement, occlusion and conflicting multiple references into one shot at the same time?
- [ ] If the target model is 2.0, is A9.1 "asset identification + formal prompt" used?
- [ ] If the target model is 2.5, is A9.2's `Objective / Reference binding / Immutable locks / Target duration / Timeline / Visual direction / Audio direction / Preserve / Avoid` structure used?
- [ ] If the target model is 2.5, does the final body pass the A9.2.0 format hard gate, with no top-level structure or extra analysis blocks other than the segment header and the A9.2 whitelisted fields?
- [ ] If the target model is 2.5, does the `Timeline` use only time blocks + continuous natural language, without a separate shot-numbering system as the main organizing structure?
- [ ] If the user provided reference images, does every relevant 2.5 segment list the needed real image nodes / asset handles exactly as is in its own `Reference binding`?
- [ ] Does `Reference binding` list only the reference assets this segment really needs, in the form "real node / handle + concise asset label"; are the user's explicit use restrictions such as "blocking only / costume only / product only" kept?
- [ ] Is "same as above / reuse the previous segment's reference images" avoided in place of rebinding in this segment?
- [ ] Is the 2.5 `Timeline` "time blocks + continuous natural language", not degraded into a pile of camera/action/performance sub-headings?
- [ ] Does 2.5 avoid outputting the A4 asset list as a whole block, instead packing the necessary information into the corresponding fields?
- [ ] Does every segment have self-contained world coordinates + frame coordinates rather than "same as above / continues from the previous segment"?
- [ ] Are state inheritance in continuous scenes and re-anchoring on scene changes correct?
- [ ] Do transitions between segments satisfy A7.3?
- [ ] Are action-continuity cuts kept within the same generation segment where possible?
- [ ] Is the dialogue copied verbatim?
- [ ] Are post-production subtitles/overlays kept away from the generation model? Is physical asset text handled per A1.3?
- [ ] If reference images were generated without a reference library, are they used only for Reference binding, with appearances labeled as design proposals, and without overstepping to control blocking/lighting/story? (A1.2 Case 2 supplement)

### A11.2 Bounded fix mechanism (prevents infinite loops)

If problems are found after the first check:
1. collect all failed items at once;
2. **do only one round of consolidated structural fixes**; structural fixes may only adjust segment boundaries, shot carrying, time budget, cinematographic expression and lock information, and **must not change any `E##`'s event content, performer, target, quantity, order or lines**;
3. after fixing, recheck only the affected items and their direct continuity;
4. then go to the A11.3 story fidelity audit and the A11.4 generation-stability pre-check; once all pass, go to A12.

**No recursion back and forth between A11 ↔ A12.**

If after one round of consolidated fixes there is still a hard conflict where "the user's requirements cannot all be met at once" (e.g. strictly 30s, but the original dialogue's natural reading time already exceeds 30s), keep the user's original and state it clearly under "Full-film overview｜Duration constraint conflicts", without endless recalculation.

### A11.3 Story fidelity audit (required before A12)

Do a one-way comparison, without showing the internal ledger to the user:

1. read `E01 → E02 → ...` in order from the source-story ledger;
2. confirm every `E##` appears in some final generation segment, with performer / target / lines / order unchanged;
3. scan the final Timeline in reverse for every action that changes world state; if no source `E##` can be found, delete that AI-added action;
4. cinematography, composition, shot size, focus, direct physical results of existing actions and foley may lack an `E##`, but must not create new story facts;
5. if deleting an AI-added action raises the question "where did this state come from", handle it per A0.1.4: take the state the user gave directly as that beat's initial state, without adding backstory;
6. if the source text itself has gaps or contradictions, keep the gaps/contradictions and flag them in the full-film overview, without inventing bridges.

**The goal of the audit is not to make the story smoother but to confirm that the final prompts and the user's story are the same thing.**

### A11.4 Generation-stability pre-check (reduces the chance of broken visuals · mandatory)

This section only reduces generation risk and **cannot promise that the model output will never break**. The goal is to remove in advance the prompt burdens most likely to cause character deformation, hand errors, props disappearing/duplicating, melting image structure and identity drift; do not delete story or change events in the name of "stability".

#### A11.4.1 High-risk triggers

When any of the following appears in a shot, mark it high risk and proactively reduce complexity:
- 3 or more subjects moving substantially at the same time, occluding each other or making contact;
- two hands / several people simultaneously handling small props, handing over, buttoning, pouring liquid, wiping or other fine contact, while complex camera movement is also required;
- large body movements such as quick turns, crouching and rising, landing, dressing/undressing or several people swapping places happening together with close-up hand details;
- compositions that easily duplicate people/limbs/props, such as mirrors, glass, strong reflections, transparent containers and multiple shadows;
- product packaging, small text, fingers, liquids or mechanical structures that must be accurate up close while also moving/rotating fast;
- one shot requiring extremely shallow depth of field, heavy occlusion, fast camera movement, fine contact and multi-character performance at once;
- too many reference images in this segment, with potential conflicts among several images about the same character, costume, scene structure or product form;
- mutually exclusive requirements within the prompt itself, e.g. "the character stays completely still" while "quickly swapping places", or "the hand always holds the pen" while "completing another action empty-handed in the same shot".

#### A11.4.2 Risk-reduction order

When there is high risk, handle it in this order until the prompt is no longer overloaded:
1. **Remove irrelevant controls, not story.** Delete camera jargon, generic negative terms, irrelevant material details and useless references that do not affect this shot; keep only the locks the current shot really needs.
2. **Simplify the camera first.** For fine hand/prop contact, prefer a locked-off camera or a single smooth movement; do not stack push/pull, orbit, fast pan and strong rack focus at the same moment.
3. **Keep key contact fully visible.** For handovers, taking, wiping, opening/closing and similar actions, choose a shot size where the relevant hands and props are visible together, and avoid the most critical contact point being fully blocked by the frame edge, a body or the foreground.
4. **Reduce depth-of-field conflicts.** When the key hand, prop and contact surface must all be readable, do not use an extremely shallow depth of field that fully blurs any of them.
5. **Don't let complex action and complex camera compete for the same moment.** If the source story allows splitting shots, carry different complex interactions in separate shots at existing `E##` boundaries; if the source story explicitly requires them to happen simultaneously, keep them simultaneous but reduce camera movement, background motion and irrelevant performance complexity.
6. **Keep only the reference images this segment really needs.** When several references of the same object serve different purposes, state the scope of each; handle conflicts per A1.2.1 and do not let the model merge them itself.
7. **Add targeted Avoid items to high-risk segments instead of piling negative terms on the whole film.** Based on the shot's actual risks you may add: no extra arms/fingers, limb fusion, facial identity drift, prop duplication/disappearance, objects passing through hands/tables, body clipping, geometry melting, extra people in mirrors, etc.; do not add them mechanically when there is no such risk.
8. **Re-break shots/segments only if still overloaded.** Use only existing source-beat boundaries; do not delete, add, reorder or change what happens simultaneously.

#### A11.4.3 Stability pass criteria

Before going to A12, confirm:
- each shot has a clear main viewing task;
- the number of characters, limb contact, number of props and action causality can be fully seen at the current shot size;
- the camera has no contradictory movement commands;
- there are no unnecessary mirror/reflection requirements that could induce duplicated subjects;
- Reference bindings do not compete for the same dimension;
- key character identity, costume, product structure and key props are locked in the appropriate fields;
- the `Avoid` of high-risk segments targets only real risks, not dozens of generic negative terms.

---

## A12. Pre-delivery optimization (final polish · single pass)

**A12 runs only once.** It is not a second round of shot breakdown, and it is not responsible for recomputing segment counts, re-cutting beats or rolling back A11.

Optimization is not rewriting; it checks presentation and executability per A12.1–A12.18 on the existing structure. Fix ordinary wording problems directly; handle structural hard conflicts per A12.19 without recursing back.

### A12.1 First-frame lock
For each shot's first frame, spell out the "applicable items":
- whether the shot has characters; if none, state explicitly "empty shot, no characters"
- characters standing / sitting / crouching / lying
- characters' frame left/right
- relative distance between characters
- body orientation
- initial eyeline target (copy it when the source story has a clear object of attention; when it doesn't, use only a neutral target that carries no new information, and do not infer new interest/hostility/attraction)
- what is in their hands
- where key props are placed
- camera distance and height
- foreground / midground / background

Do not invent items that do not apply.

### A12.2 On-screen locks are applied per shot
Follow A4's internal timeline status plan; even without a separate asset identification block, 2.5 must express the same on-screen constraints in Timeline / Immutable locks.

For characters who must not appear in a shot, write explicitly:
- not on screen at all;
- no face / body / shoulder / hand / reflection / shadow / out-of-focus figure (choose as needed);
- if there is only off-screen synchronous dialogue, state clearly "voice only".

Especially for POV shots, partial shots, over-the-shoulder shots and single shots, prevent the model from automatically adding another character.

### A12.3 Optics: write visible results, don't rely on lens models
- ❌ "85mm f/1.4"
- ✅ "portrait-feel short-telephoto view, natural facial perspective, lightly blurred background"

Lens models may help, but the focus is the final visual result.

### A12.4 Camera contradiction check
Keep only one main camera movement logic per shot.
- ❌ "camera completely fixed while slowly trucking sideways"
- ✅ "camera fixed, with only one very slow rack focus"

### A12.5 Avoidant cinematography (only for restrained/understated styles)
When the user's style is restrained or understated, you may prefer:
- hand close-ups / cups / red string / floor edges
- over-the-shoulder / blocked by a pillar / out-of-focus foreground
- two-shot medium / fixed wide shot

Do not force this onto other styles such as action, broad comedy or product experiments.

### A12.6 Performance: behavior, not abstract emotion
- ❌ "he is sad"
- ✅ "he was raising his cup; the motion stops for about 0.4 seconds, then he keeps drinking"

Prefer writing **reactions already in the source story** as visible actions. A pause in the gaze / fingers tightening / the cup pausing / lips parting and closing again / breathing changes / weight shifts may only be used when consistent with a source-story reaction, never as a new performance event added by the AI.

### A12.7 Micro-expression density
Usually 0–2 clear micro-expression events per character per shot. When the shot can't see the face, don't write facial reactions.

### A12.8 Make eyeline targets specific
Only when the source story already states that a character looks at someone/something/somewhere, make the target specific. If the original has no object of attention, do not pick a target that carries story meaning yourself.

The natural order of behavior can be written as "eyes move first → head follows", but only to present a look that already exists in the original, not to add a new look.

### A12.9 Avoid mechanical sync in two-person actions
If the source story itself contains two existing actions that can run in parallel but whose exact sync is not locked, you may offset their rhythm slightly without changing event order and causality. **Do not add actions for either character, delay key events, or change a clearly simultaneous relationship for the sake of "naturalness".**

### A12.10 Action causal chains
Prefer organizing **existing source beats** into a clear causal chain; if the user's original really contains several actions, keep them all and only distribute them across shots; do not delete any source event for the sake of "one core action per shot". Decorative actions the AI added itself should be deleted.

### A12.11 Prop continuity (within a segment + related cross-segment)

For each key prop, check at least: **holder, hand used (if specified), absolute position, visible/occluded state, quantity, orientation, open/closed, liquid level/contents, wear, stains/wetness, where it ends up at segment end**.

- Within a segment, scan time block by time block as "initial state → source story action → end state"; for continuous segments, also compare the previous end state with the next initial state per A8.3.
- If a pen is still held by a character and there is no put-down, handover, put-away or drop corresponding to a source `E##`, it cannot vanish from nowhere the next moment.
- If the next shot does not show the prop because of cropping or occlusion, that does not mean the prop has disappeared; the world state continues.
- If the same hand is still clearly visible and the prop is gone without a source, it is a continuity failure; if both hand and prop are off-screen, record only "still held by that character / still in its original position" and do not change the state from nothing.
- A prop that was put down cannot return to the hand without process; an object already given to B cannot also be in A's hand at the same time; quantity cannot increase or decrease without cause.
- When the source does not specify left/right hand and the shot does not need it, do not force a hand lock; once the prompt has specified a hand for execution, that hand cannot switch without process in related continuous shots.

No unjustified restoring or resetting: a cup that was drunk from suddenly full, a stain that was wiped away suddenly back, an open door closing without action, a broken prop automatically whole, consumed items restored in number.

### A12.12 Physical realism
Focus on liquid inertia, fabric folds, hand–prop contact, object weight, table vibration, collision feedback, glass refraction/reflection, etc.

### A12.13 Lighting consistency
Keep the key light direction, color temperature and exposure logic within the same continuous scene. On scene changes/time jumps, re-establish them per A5.5 without forcing inheritance.

Do not suddenly add rim light, strengthen catchlights or change exposure just because the story moment is important, unless the user's style explicitly asks for it.

### A12.14 Sound
By default keep only real synchronous dialogue and ambient/action sound. Whether BGM, a score or emotional sound effects exist follows the user's requirement; if not requested, do not add them automatically, and default to no background music.

### A12.15 Original dialogue + duration
Dialogue the user provides must be:
- copied verbatim
- with no changed words / changed sentence patterns / added interjections / repetition / improvisation

A12 **must not** solve dialogue not fitting by "speeding up speech"; such problems should already have been handled in A11. A12 only fine-tunes pause wording notes, without changing structure.

### A12.16 Positive locks first
Prefer writing executable states:
- "Character A stays on frame left throughout this shot"
- "The cup is held in Character A's right hand"
- "Character B is fully off-screen in this shot"

Then add the necessary prohibitions.

### A12.17 Text lock
By default write:
- no subtitles
- no extra on-screen text
- no post-production titles/caption cards/UI overlays/watermarks

If the shot contains physical asset text such as product packaging, signboards or letters:
- with a reference image → keep the reference asset; do not add, rewrite or redraw the text;
- do not ask the model to additionally generate "clear, accurate new text";
- lock text word for word only when the user explicitly asks for readable text.

### A12.17.1 Reference image binding completeness (Seedance 2.5)
When the user provides reference images, A12 only checks whether the binding is complete and its use clear; in the optimization stage, do not replace, delete, merge or add reference images on your own.

- Every relevant segment must keep the real reference nodes / asset handles it needs;
- do not remove them from the next segment because "the previous segment already bound them";
- do not expand a "blocking reference only" into a character-appearance reference;
- do not bring the background, unknown people or extra props of a character reference image into the story;
- do not rewrite complex text in a product reference image into new packaging copy.

### A12.18 Add general restrictions as needed
Choose for the current project:
- no added characters / props / dialogue / story actions
- no crossing the axis without reason / no swapping character positions without process
- no MV-style fast cutting
- no advertising-style fill light / skin smoothing without a style basis
- no exaggerated depth of field / no unnatural slow motion

**Do not mechanically paste restrictions unrelated to the current shot.**

### A12.18.1 Final continuity and continuity-error risk audit (mandatory before delivery)

After A12 finishes polishing the wording and before final output, do one more **one-way audit**, without returning to A11 or triggering a second A12:

1. **Build start / end snapshots for each segment**: characters' world positions, poses, orientation, on-screen status and hand occupancy; key props' holder/position/quantity/state; persistent scene states such as doors/windows/furniture/stains/light sources.
2. **Compare only the segment pairs A8 classified as "continuous / partial-state link"**. For adjacent segments without a continuity relationship, do not force a comparison of character positions; only check whether each segment makes sense on its own.
3. **Character continuity-error check**: unsourced teleporting, unsourced side switches, standing↔sitting without process, the same character duplicated as two people at the same world position, on-screen/off-screen contradicting the camera description.
4. **Prop continuity-error check**: unsourced disappearance, duplication, hand switch, return to hand, quantity change, open/closed reset, liquid level/stain/damage restored; especially check for "holding it one second, and the next second the same hand is clearly visible but empty".
5. **Spatial continuity-error check**: fixed furniture shifting, door/window states jumping, characters passing through walls/tables, objects passing through hands, sudden scale changes between characters and furniture, extra nonexistent people or props in reflections/mirrors.
6. **Generation-breakdown risk check**: whether high-risk shots have already reduced camera movement, occlusion, depth of field, concurrent contact and reference conflicts per A11.4; whether the necessary targeted Avoid items were added for this shot's real risks.
7. **Story fidelity recheck**: all fixes may only change cinematographic expression, lock information, occlusion/visibility descriptions and shot carrying; do not add bridging actions such as "put the pen down", "pick the pen up again" or "walk back to the original spot" to cover up continuity errors.

If the problem is a contradiction within the AI draft itself, fix it directly in this A12 pass to match the confirmed state; if the source story itself is contradictory, keep the original and flag "source-text conflict" in the full-film overview.

**This section is a prompt-side audit of continuity-error risk; it does not mean the actually generated video is free of such errors. Whether the real video shows extra hands/fingers, limb fusion, face changes, props flickering/disappearing, clipping, mirror errors, etc. must be checked separately as result acceptance once the media can actually be read.**

### A12.19 Optimization limits and termination conditions (prevents infinite loops)

A12 may not change:
- the user's original lines
- **the actions, reactions, number of events, performers, recipients, props, information or causality of any source-story `E##`**
- **vague identity levels in the user's original (e.g. "parents/guardian/adult" must not be arbitrarily made specific)**
- the core intent of the story
- the beat order confirmed in A11
- the film's actual segment count / each segment's duration
- global segment numbers / Batch plan
- key asset identities
- the confirmed world-coordinate logic

A12 may only:
- make descriptions more concrete and executable
- complete first-frame/on-screen locks
- reduce over-acting
- add physics, lighting, sound and continuity wording
- clean up contradictory wording

**Distinguish conflict sources:**
- if the conflict is a wording error the AI draft created itself (e.g. the same shot says the cup is held in both the left and the right hand) → fix it directly in A12 to match the state confirmed in A11;
- if the conflict comes from the user's source script itself (e.g. two mutually exclusive positions explicitly written for the same moment) → do not change the story yourself; flag "source-text conflict" in the full-film overview.

**Termination rule:** after A12 runs once, only do the final checklist; do not return to A11 and do not trigger a second A12.

Final checklist:
- [ ] All source-story `E##` appear, with order, performers, targets and lines unchanged
- [ ] No added story actions without a source `E##` in the Timeline
- [ ] No backstory or prop origins added, no vague roles made specific
- [ ] Applicable first-frame items complete
- [ ] Each shot's on-screen status consistent with A4
- [ ] No camera contradictions
- [ ] Performance visible and not overloaded
- [ ] Eyeline targets specific
- [ ] Props / physics / lighting continuous
- [ ] All adjacent segments classified per A8; segments with a continuity relationship have consistent character positions/poses/orientation, and unrelated segments are not wrongly hard-locked
- [ ] No unsourced disappearance, duplication, hand switch, return to hand, quantity change or state reset of key props; framing/occlusion not mistaken for a world-state change
- [ ] Continuity-error risk audit of space/doors and windows/furniture/reflections/mirrors/clipping completed
- [ ] High-risk shots passed the A11.4 generation-stability pre-check with targeted complexity reduction
- [ ] Original dialogue unchanged
- [ ] No AI-added subtitles/overlays
- [ ] Physical text handled per the reference asset
- [ ] No structural rollback / no loops
- [ ] If the target model is 2.5, the final delivery contains only A9.2-allowed fields, with no old three-part shell, 2.0 shell or shot-numbered main structure
- [ ] Generated reference images (if any) used only for Reference binding, appearance labeled as a design proposal, without overstepping into blocking/lighting/story (A1.2 Case 2 supplement)

**Checklist complete → output the final version.**

---

═══════════════════════════════════════════

---

## Working on the canvas

Actual production is presented on the current canvas by default, but **the Seedance route takes precedence over canvas discovery and configuration**: if an executable script/timeline exists and the current goal is video production, generation, continuation or revision, you must first complete the corresponding Seedance prompt planning/finalization per PART A of this file, then enter [Canvas Execution](references/canvasExecution.md) to read the canvas overview, target nodes, local connections, model configuration, ports and node functions as needed. Do not skip PART A because you need `getConfig`, need to choose resolution/aspect ratio/mode, or the host pops up a configuration question. Only when the video production stage has not yet been reached do you discover the canvas first, per the ordinary flow. "Finish the script and asset plan first" only limits the stage; it still uses text nodes and does not trigger media generation. Omit node operations only when the user explicitly wants chat text, consultation or no canvas operations. The workspace is the host's current project; when no canvas is open, state the specific condition and continue with the text parts that can be completed.

| Stage reached | Current result | What to read |
|---|---|---|
| 1. Content and scope | Original text or script text node; a production brief if needed | [Input and Script](references/sourceAndScript.md) |
| 2. Assets | The character, scene and prop list for the current scope and the images actually adopted | [Asset Production](references/assets.md) |
| 3. Seedance prompts | The full-film plan, segmentation and formal prompts covering this run's story; **execute only the embedded PART A in this file** (2.0 uses A9.1, 2.5 uses A9.2); do not read storyboard or methods in this stage | **Only the embedded PART A in this file** |
| 4. Generation and adoption | Current clip generation nodes, real outputs, feedback and adoption records | [Canvas Execution](references/canvasExecution.md), [State and Delivery](references/stateAndDelivery.md) |
| 5. Delivery or continuation | Index of the valid script, assets and clips, the actually completed scope and the next step | [State and Delivery](references/stateAndDelivery.md) |

Create only the nodes needed for the stage reached so far. One story clip may have several shots and by default corresponds to one complete prompt and one video generation node; do not generate keyframes for every shot first by default. Edges carry actual material; they do not mean approval or automatic scheduling.

Formal assets in story production are based on this run's confirmed complete script; when designing a character, scene or prop on its own, base it on the design requirements the user confirmed and existing material, without requiring a script to be written. When the user asks for both a script and an asset plan, you may extract the asset list and design drafts in the same round, noting the pending script they depend on, and not treating the drafts as authorization to generate. Characters don't need a full life story first, and voice-only characters don't get a useless portrait. Style, performance, action and continuity go directly into production materials and shots, with no mandatory separate report for each; when there is no need for fights, special props and the like, do not create empty documents.

## Read methods for the current creative problem

Execution rules determine how to save, generate and continue in Toonflow; the methods below are **only for creation/adaptation/asset design before the Seedance prompt stage, or for media execution after the finished Seedance prompts**. Once Seedance prompt hard isolation is entered, do not read any creative method in this section; before and after prompt finalization, these methods must not override PART A.

| Problem being solved | Method to read | Where the judgment goes |
|---|---|---|
| Breaking a confirmed script into Seedance 2.0/2.5 segment prompts (beats, duration, blocking, performance, camera movement, continuity, templates) | **The embedded "SEEDANCE EPISODE DIRECTOR · PART A" in this file** | Segment plan, each segment's formal prompt (A9.1/A9.2), story fidelity lock |
| Ideas, character drive, causality, outlines or sequels | [Story Development](references/methods/storyDevelopment.md) | Action premise, event chain, choices and outcomes |
| Turning a novel into picture and sound: scenes, inner thoughts, dialogue and duration | [Screen Adaptation](references/methods/screenAdaptation.md) | Scenes, complete actions and sound, adaptation proposals and time estimates |
| Appearance, space, prop structure and persistent states | [Visual Design](references/methods/visualDesign.md) | Asset anchors, spatial masters and variants |
| Style, inherent material color, how light falls, and grading | [Color and Light](references/methods/colorAndLight.md) | Shared visual basis, scene lighting and clip constraints |
| Story writing/adaptation before finalization | Use only the story development and screen adaptation methods above | Produce a script that can be confirmed; once it is finalized and Seedance begins, stop using these methods immediately |
| Media execution and acceptance after the finished Seedance prompts | [Canvas Execution](references/canvasExecution.md), [State and Delivery](references/stateAndDelivery.md) | Only execute the finalized prompts, connect real references and verify real results; do not write separate prompt rules |

The conclusions of these methods go only into script/asset design results **before Seedance**; once Seedance prompt hard isolation is entered, no method conclusion may be written into or rewrite the final prompts directly, and PART A must reprocess them from the confirmed inputs. Method examples, genre rhythms and style candidates do not automatically become facts of this project.

Only when the cost of handover and merging is lower than the independent analysis work may `subAgent` share fact extraction or material organization from long source texts **before Seedance**. **In the Seedance prompt hard-isolation stage, do not let a subAgent independently draft, rewrite or optimize segment prompts**; A0–A12 must be completed together by the same main execution chain, so that subtasks don't bring in a second set of shot/performance/continuity rules.

Do small amounts of text, asset inventory, connections and layout directly, without assigning fixed roles or extra review rounds. Division of work is limited to independent content processing and does not change the later confirmation, generation and adoption flow; later generations that depend on the real results of earlier ones still wait for those results.

## Confirmation and execution

- Show substantive stage results and confirm whether to adjust; content the user has already explicitly approved and continuous production scope carry over directly. Don't turn every tool call, internal analysis or unrequested sub-step into a question.
- Record content confirmation, authorization to consume compute, and adoption of results separately. Before generating, show a reviewable concrete plan: targets and quantity, model, complete prompts, actual references, specifications and number of runs. To the user, consistently call it "消耗算力" (consume compute); when it cannot be queried, write "算力消耗未知" (compute cost unknown).
- Obtain authorization through the host's `askUser` or an explicit reply. Do not re-ask node by node for the same approved concrete plan or batch; when adding quantity, changing the actual plan or retrying extra, check whether the authorization covers it. An ordinary "continue", silence or a failed form is not new authorization to generate.
- The Seedance target model is determined only per PART A A0; **when unspecified, you must first confirm 2.0 or 2.5 with one short question.** That question belongs to Seedance A0, not canvas configuration, and must not release the route latch. Only after the target model is confirmed and PART A is entered does the canvas layer check, via live configuration, whether that model/mode can actually run. Node defaults, host defaults, configuration forms, historical configuration, or the user's answers about resolution/aspect ratio and similar settings must never override or release A0's model routing in reverse; after the configuration exchange, continue in the current Seedance execution state.
- Having dialogue does not mean an external voice sample is required. Sound wording in prompts follows only PART A; in actual execution, only check via [Canvas Execution](references/canvasExecution.md) whether the model supports native sound and real audio input, and do not rewrite PART A's dialogue/sound rules based on that.

## Baseline for completion and recovery

Text node bodies are saved through node functions, and the file path is read from the actual `data.textPath`. Cross-round production uses one concise status record and one overview node; keep using the existing ledger and don't require redoing it for lack of a fixed template.

Text pending confirmation or already adopted needs a fixed version basis, and generation must keep this run's prompts, parameters, references and old outputs. After confirmation, check the actual nodes again so that changes the user made while waiting are not treated as approved; adopted material is preferably pinned in material nodes, and revisions create new candidates. See [State and Delivery](references/stateAndDelivery.md) for details.

When a native media node currently returns `generating`, that only means it has started; do not claim it is finished. If this round has no real status or wait tool, after completing this round's authorized, dependency-free starts and text work, record it and tell the user to reply when it finishes, then read the corresponding nodes back; do not invent automatic wake-ups or background polling. For consecutive clips, later generations wait until the earlier ones are adopted and their real boundary states are obtained; text planning may list expected states first. Dependency-free assets or clips may be scheduled in batches with explicit authorization.

A video path does not mean the Agent has watched the video. Verify only according to actual media-reading capability; when capability is insufficient, the user previews and reports problems, boundary states and adoption decisions, and you clearly state which parts the Agent did not verify. Delivery distinguishes generated clips, user-adopted clips, composited finished films and collected copies; without the corresponding tool, truthfully deliver the existing results and what is missing.

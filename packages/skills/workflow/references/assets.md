# Character, Scene, and Prop Assets

> **Seedance usage boundary:** This file is not a set of Seedance segmentation or prompt rules. After entering PART A of the main `SKILL.md`, read this file on demand only when A1.2/A4 explicitly requires adding real reference assets or necessary design proposals. Use it only for asset appearance, structure, space, and material; never derive from it a second set of rules for duration, shots, performance, camera movement, continuity, or templates.

Read this when inventorying the assets the current script needs, designing assets on their own, or preparing reusable visual material. When the user has authorized delivering the script and the asset plan in the same round, you may extract the list and design proposals from the script draft and mark them as pending confirmation; formal assets in story production are based on the confirmed version. Standalone asset tasks are based on the design requirements the user confirmed and the existing material, and do not require a script or scenes; fill in the sources and statuses below only with what this task actually needs. For script scope and adaptation methods see [Story and Script](sourceAndScript.md); for node configuration and generation see [Canvas Execution](canvasExecution.md).
Assets fix identity, space, and objects; performance, camera movement, and dialogue go into the video prompt. First reuse confirmed material that fits the current setting, then fill the real gaps.

When you need to design or revise appearance, space, props, or variants, read [Visual Design Methods](methods/visualDesign.md); derive them from story facts, action constraints, and recognition needs, then write them into asset entries and prompts. When you need to set the art style, palette, materials, or lighting, read [Color and Light](methods/colorAndLight.md), and distinguish an asset's base colors, scene lighting, and segment grading. When suitable material already exists, only reuse it; do not redo the design.

## Extract requirements by production scope

- For story production, read the entire episode, scene, or other agreed scope for this task in full, plus the context needed to understand continuity; for standalone design, read the current design requirements. Do not require a separate plan, outline, or full character biographies first.
- Inventory characters, scenes, key props, and persistent states scene by scene; merge aliases of the same identity and record the source and applicable scope. Do not prepare assets only for the first video and then claim the whole film is covered.
- In story production, a standalone asset should actually appear on screen or take part in visible action, and need reuse or a separate reference. Characters only mentioned in dialogue, incidental decoration, and voice-only characters do not automatically get portraits or prop images.
- For characters, record species, age or growth stage, silhouette, distinguishing features, and necessary costume; for scenes, record spatial anchors, passages, time, and environmental state; for props, record form, material, size relationships, holder, and state.
- Create the necessary variants for changes that affect recognition across segments, such as a change of costume, a transformation, a lasting injury, or a damaged prop; do not create separate assets for momentary expressions, turning around, or partial close-ups.
- Appearance that was not provided may be offered as a design proposal, but never presented as a fact from the source text or reference images. When key identity, quantity, or story function conflicts, clarify only the affected items.
- Reuse old images that are actually readable and suitable as they are; do not redo them for a uniform layout. Names, prompts, placeholder paths, and style references cannot pass for an existing concrete asset.

The asset table may be merged into an existing production document; do not create a duplicate set of body text:

| Asset ID and name | Type and state | Script or design-requirement source and scope of use | Appearance or structure anchors | Existing nodes and real files | Handling this time | Status |
| --- | --- | --- | --- | --- | --- | --- |
| {stable ID, name} | {character / scene / prop, base state or variant} | {scene, event, segment, or specified design purpose} | {what stays fixed and what may change} | {actual location; write "missing" if missing} | {reuse / add image / variant} | {to design / to generate / generating / awaiting review / adopted} |

## Characters: close-up and full three views

By default, a new character uses one reference sheet, arranged horizontally as **head close-up, front full body, right-side 90° full body, back full body**. The four views depict the same identity in the same state; they are not four characters.

- The close-up keeps the whole head down to around the collarbone; the three full-body views keep the top of the head, the body, the limbs, and the feet, without cropping the head, cutting off the body, or cutting off the feet.
- The full-body views share the same scale, while the close-up may be enlarged; identity, build, hairstyle, costume, palette, and carried items are consistent, and the views do not overlap.
- Use a natural static pose, a neutral expression, and a simple background that fits the art style; do not mix in story scenes, action in progress, other characters, or annotations.
- Adapt animals to their established body structure and natural posture; legless, wingless, or special growth stages do not grow extra organs because of the template. Record the number of appearance samples for a group separately from the number that appears in the story.
- Keep any layout the user specified and any suitable old images. A variant uses the actual base image and changes only the parts, costume, or objects that are justified, and keeps the items that do not change.

```text
{Confirmed style} character reference sheet of one character: {name, identity or species, age or growth stage}.
Appearance anchors: {silhouette, build, head features, skin or fur, palette, costume, and necessary identifying items}.
Arranged horizontally in one image: head close-up, front full body, right-side 90° full body, back full body.
Identity and state are consistent across views, full-body scale is consistent, {applicable body structure} is kept complete, with no cropping or overlap.
{Natural static pose}, neutral expression, {simple background and lighting or flat-color treatment that fits the style}.
{Fill in only with a real reference: use the identity and state of {{ref N}}, change only which confirmed details, and keep which parts.}
Keep necessary confirmed text or patterns such as costume and emblems; no story scene, extra characters, action in progress, unrelated caption text, watermark, or dimension annotations.
```

## Scenes: a reusable spatial master view

- By default, one master view that explains the location, showing foreground, midground, and background layers, the main entrances and exits, passages, and stable architecture or terrain; keep the space characters need for their actions.
- Within one location, split off a separate asset only for spaces that are structurally different and carry story on their own. When time, weather, or damage state changes, add variants as actually needed; do not enumerate every direction.
- A standalone scene image does not include characters, silhouettes, or story animals; later videos add the subjects through character references. Do not turn the scene into an object display on a gray background.
- Spatial rendering follows the art style; flat color blocks do not need forced realistic depth of field or complex shadows. Use a panoramic sheet only with a layout the user confirmed.

```text
{Confirmed style} scene master view: {scene name, interior or exterior, geographic or architectural type, time of day, and weather}.
Foreground {elements leading into the space}; midground {main activity area and fixed objects}; background {boundaries and distant structures}.
Spatial relationships: {entrances and exits, passages, stable landmarks, and necessary relative positions}, keeping {activity space the story needs}.
Materials and visuals: {materials, palette, and lighting or flat-color treatment that fits the style}.
Single-frame master view, {viewing height and direction}, clear structure; no characters, silhouettes, story animals, story action, or annotations.
{Fill in only with a real reference: use {{ref N}} to keep which layout and materials, changing only which time of day, state, or viewpoint.}
```

## Props: show structure as recognition requires

- Add images only for story-critical objects that existing assets cannot fully cover; do not split ordinary decoration into separate items, and treat clothing and accessories as part of the character's appearance where possible.
- By default, a new prop uses the current Toonflow 2×2 reference sheet: front, right side 90°, back, and a detail close-up. A confirmed standalone still-life image that covers the current use may be reused as is; when the user chose a single image, keep it and do not add images that serve no purpose just for the layout.
- Multiple views always show the same object, with consistent structure, material, size relationships, and state across views; a detail close-up only enlarges structure that actually exists.
- Props are placed on their own, without people, arms, or holding poses. Keep existing text, symbols, or patterns as the story requires; do not add unrelated caption text or watermarks.

```text
{Confirmed style} prop asset of a single object: {name, form, purpose, material, palette, size relationships, and state}.
Key structure: {functional parts, decoration, and details that affect recognition in the story}.
Presentation: {default 2×2: top left front, top right right side 90°, bottom left back, bottom right detail close-up; replace this item when the user has another confirmed layout}.
Same structure and state in every view, shown completely without cropping, {simple background and lighting that fits the art style}.
{Fill in only with a real reference: use {{ref N}} to keep which structures, changing only which confirmed state.}
No people, hands, extra objects, or story background; {actual text or patterns to keep}, no unrelated annotations or watermarks.
```

## Voice characters and visual states

Characters who appear only as OS, VO, or off-screen dialogue keep their voice identity, line sources, and voice description; do not generate portraits that serve no purpose for them. Describe a voice by register, timbre, speaking rate, accent, and delivery habits, and carry it across segments.
When the current video model supports native audio, the confirmed written voice description may be used directly; use real audio as a voice reference only when such material actually exists and the capability supports it. Do not fabricate references, and do not make obtaining an external voice sample a prerequisite.
Changes to visual assets do not automatically change voice identity. Record persistent variants as "original state → triggering event → new state → applicable scenes", and keep the old state for earlier segments.

## LoRAs for recurring assets

When a character, place, outfit or look recurs across many shots and the production uses Sulphur 2 video or Qwen-Image keyframes, propose training LoRAs as part of the asset plan and prepare the role-tagged, consistently named images they train from, as [LoRA](lora.md) describes. Training is the user's decision because it consumes compute.

## Preparing generation and review

- First deliver the full list and designs for viewing, then produce missing items as the user authorizes; record prompt preparation and actual generation separately, and handle generation authorization uniformly through [Canvas Execution](canvasExecution.md).
- Choose the model, aspect ratio, resolution, and reference mode from the actual `node:getConfig` capabilities; a horizontal reference sheet must fit complete bodies, and the parameters must match the text layout. Do not tie this to a particular model or a fixed frame size.
- After real material is connected, check reference numbers and purposes. When a variant lacks the base image it needs, mark the reference as pending; do not pretend image-to-image is done. Authorized text work may continue.
- Check identity, structure, complete bodies, view order, persistent states, spatial layout, whether subjects slipped in, and file readability; show the actual images and issues, and record adoption according to the user's decision.
- Videos reference only the identity, space, and structure of assets; they do not reproduce the reference sheet's background, grid, or number of views. The number of people and objects in the story is determined by the script.
- Keep adopted material separate from candidates; a change only affects the segments that actually use it. Record versions and delivery according to [State and Delivery](stateAndDelivery.md).

# Organizing the Viewing Experience with Color and Light

Use when the user asks for style exploration, assets are lit inconsistently, the look of segments drifts, or important actions and information are hard to see.
When an already confirmed style can accomplish the current task, inherit it directly; don't add a color chart for every scene, and don't automatically change the palette because the emotion changes.
For base form and identity grounds, see [Visual Design](visualDesign.md); conclusions are used for asset/visual design in non-Seedance stages. If A4 in PART A of the main `SKILL.md` explicitly invokes this method, return only the necessary color and lighting design proposals, without establishing independent storyboard or prompt rules.
This method provides design and prompt control; written values don't mean an executable LUT file has been produced, loaded or verified.

## 1. First write what the audience needs to see at this moment

Applies: you only have a direction like "cinematic", "oppressive" or "warm", and don't yet know how it should land in the image.
Rewrite abstract emotion as a viewing task, for example "first see her clutching the envelope, then realize someone else is behind the door".
Use story facts to limit what may vary: time, weather, light-switching events, characters' identifying colors and spatial structure can't be rewritten by style words.
Then pick only the most effective means: value separation between subject and background, local color differences, the amount of information in the shadows, or the coverage of the light.
Judge whether to reinforce the plot, counterpoint the conflict with a calm image, withhold judgment for now, or express a character's subjective feeling; don't just look up a color scheme by genre.
Output destination: a one-sentence visual goal for the scene or segment, and the light and color controls chosen to achieve it.
Misuse: switching to red light as soon as there's an argument and tinting blue as soon as there's sadness; changing the filter with every line's emotion within the same scene.

**Teaching example**: a family is still eating in a bright kitchen, but under the table someone hides a dropout notice in a bag.
You can keep the existing warm everyday base and make the paper and the bag's opening discernible in key shots; there's no need to suddenly switch to a cold suspense space.
The conflict comes from the audience knowing what the others don't, and stable light and color alone can create the counterpoint.

## 2. Separate object base color, environmental lighting and the final look

Applies: colors in reference images are mistaken for materials' base colors, or grading requests start changing clothing, skin tones, walls and object materials.

| Layer | What it determines | Where to write it |
| --- | --- | --- |
| Asset base color and surface | The inherent color scheme, texture, roughness or translucency of clothing, hair/fur, walls and props | Asset anchors and necessary keep items |
| Ambient light and material response | Where light comes from, where it falls, light-dark relationships, and how the same surface reflects or transmits light | Scene state, and the segment's space and light |
| Final color treatment | White balance target, overall color cast, shadow-highlight relationship, saturation, contrast and texture | The segment's style section, with a shared base attached when needed |

First fix the asset layer, then read the current time of day and the real light-source relationships, and finally decide the overall color treatment.
For example, a white shirt can look warm under warm lamps, but the asset is still white; don't write the blue in every night reference as the clothing's base color.
Warm or cool post treatment can't conjure new windows, move lamps or change switching events; when those changes are needed, go back to story and spatial design.
Conversely, an actual lighting change doesn't have to dye all clothing, skin tones and props the same color.
When outputting, keep the duties of these three layers separate, and in the final segment combine them into one compatible description; don't hand over two competing sets of lighting and grading instructions.

## 3. Choose grading tools from the image problem

Applies: style words can't guide production, or several segments show obvious differences when put side by side. First pinpoint which object, area and shot the problem occurs in, then choose the change; parts without problems inherit the existing design.

**When necessary information can't be seen, deal with values first.** Set hue aside for now and judge whether hands, faces and objects merge with the background at the same value. You can adjust local contrast, shadow density or highlight roll-off; don't automatically raise contrast across the whole image. Besides lightness, shadows may also carry color, which must be described separately: for example, keep the darkness under the cabinet but reduce the color cast in it that makes the brass hard to recognize. Lifting the black level too much washes out outlines, and over-compressing the highlights can weaken a lamp's glow.

**When things are visible but the wrong thing reads first, deal with competing colors.** Check whether the color block that grabs attention first fits this shot's goal. You can pull back background saturation, or let a small amount of existing color contrast with the main color; you can also solve it through composition without changing color. Main and secondary colors describe proportion of the frame, position and contrast relationships, not reassigning a character's clothing colors. When adjusting only one area, state its extent, so skin tones and key identifying colors aren't drained along with it.

**When single shots look right but color shifts across shots, check a common reference.** Find how the same material looks under similar lighting conditions, and distinguish actual light-source changes from overall white balance drift. For warm or cool adjustments, first decide how neutral objects should appear, then judge whether to keep some overall cast; don't write a lamp's color temperature directly as the post white balance. If the scene facts haven't changed, don't mask the inconsistency by switching the main color in every shot.

After making a choice, wrap it up with a verifiable one-sentence goal, for example "tool edges in the dark are discernible, the warm bright area on the counter is kept, the red packaging in the background is less prominent". Contrast, saturation, shadow color, main and secondary colors, and warm and cool can still be combined, but each should serve this goal rather than filling out a fixed parameter table.

Add midtone density, grain or softening for texture only when needed; first confirm they won't obscure action, text and material differences. Conclusions go into the shared style base or this segment's style constraints; specific values follow the conventions in the next section.

## 4. Use numbers only when their meaning is clear

Applies: the user has provided parameters, or communication with post really needs quantification. When no software is specified, prefer describing relative relationships and visible effects.
Numbers must come with the object they act on, the unit or scale, and the reference baseline; "contrast 70" lacks a definition and can't be reused across software.
Hue or color values can serve as color references, but state whether it's a shadow cast, an asset color or a light color; don't demand that the whole image be filled with that color.
Light-source color temperature, camera or grading white balance, and the final visual warmth or coolness are different concepts and can't be inferred from one another just by the size of the numbers.
If flat 2D has no real light or camera model, write the visual warm or cool lean directly; don't force a Kelvin value onto every color block.
Relative adjustments must also say which version they're relative to; without a common baseline, "background more restrained than the subject" is often easier to check than an arbitrary percentage.
Parameters in model prompts are target descriptions; they can't be used to claim the actual output hits them exactly or has formed a technical LUT.
Misuse: copying a whole row of values from a style library, renaming the style, and treating it as a reliable parameter configuration for the current model.

## 5. Lighting needs motivation first, then a hierarchy of attention

Applies: the story has a light-source event, the direction of light in a space needs continuity, or the arrangement of light and dark affects how performance and clues are read.
For ordinary style discussions, just describe the light-dark impression; don't force in lamp positions, angles of incidence or fixture lists to look professional.

1. **Find the grounds**: read the existing windows, doors, lamps, fires or luminous objects and their on/off states; when an off-screen source can be reasonably inferred, mark it as a design proposal.
2. **Set the viewing focus**: is what needs recognizing now a face, hands, the silhouette of an action, an exit or an object; the face is not always the brightest thing.
3. **Organize light and dark**: decide the main bright areas, necessary dark areas and background layers, so the point of focus stands apart and irrelevant details are allowed to recede.
4. **Choose hard or soft**: use harder edges when clear cast shadows or strong separation of form are needed; use softer edges when gentle transitions are needed.
5. **Check spatial consistency**: describe direction with real anchors such as the window side, outside the door or near the desk lamp; changing the camera position doesn't move the light source to the other side.
6. **Check the range of action**: when a character walks from light into shadow, the light on them should change with their position; opening a door, blocking and switching off a lamp have an order of occurrence and an end state.

The key light does the main modeling, and ambient or bounce light can preserve information in the shadows; whether to add separation is decided by readability, not three-point lighting by default.
Dark-colored characters don't necessarily need a glowing rim; they can also be separated through background value, pose and space left around the silhouette.
Low light doesn't mean crushing everything to black in post; low contrast doesn't mean all areas are equally bright, and there still needs to be a viewing focus.
The hardness of light is seen in shadow transitions and can't be replaced by warmth or brightness alone; don't treat "soft light" as a guaranteed recipe for happiness.
Output destination: necessary light-source relationships and changes go into the segment's start state, action and end state; the overall color goes into the style section of the same prompt.

**Teaching example**: after a character switches off the bedside lamp, the screenplay still requires seeing him put a key into a drawer.
First check whether the confirmed space has grounds such as light through the door gap, then decide whether the action happens before the light goes off or in the existing dim light; don't add a moon or a window to save the day.
If the plot and visibility truly conflict, propose the specific affected adjustment; don't quietly change the order of events in the generation prompt.

## 6. Change what you control by medium

The same "subject clear, shadows stable" needs different wording in different media; first carry over the medium the user has set and the existing assets.

| Medium | Priority controls | Misuse to avoid |
| --- | --- | --- |
| Flat 2D or cel | Characters' main colors, line art, shape and edges of shadow color blocks, value hierarchy between subject and background | Adding realistic skin scattering, complex reflections and random gradients by default, turning the established art style into 3D plastic |
| 2D watercolor or painterly | Blending of color blocks, edge hardness, consistency of paper texture or brushwork, clarity of key outlines | Treating uniform hard black lines and hard-edged shadows as required for all 2D |
| Stylized or realistic 3D | Volume, light-source relationships, bounce color, surface roughness and highlights, necessary translucency response | Giving all materials the same sheen, or adding fog, depth of field or rim light without grounds |
| Live action or photoreal footage | Exposure relationships, believable light sources, skin tone differences, costume recognition, material layering and highlight roll-off | Smoothing skin across the board, unifying skin tones, using heavy filters to cover lighting or exposure contradictions |

For 2D, first check whether color blocks are still distinguishable when the image is scaled down; line art can be black, colored or subdued, chosen according to the established style.
The area and edges of shadow color blocks should stay stable across shots, without random gradients added each time; the degree to which atmospheric color has an influence must still protect recognition.
The background can drop in saturation or detail, or stay bright and be separated by outline and value; don't treat lowering the background by a fixed percentage as a formula.
For 3D, look at material differences first: matte cloth and metal shouldn't show the same highlights, and a transparent object isn't just an opaque one made lighter.
Describe translucency or subsurface scattering for skin, wax, thin leaves and the like only when needed, and don't apply it to metal; don't use strong translucency to express every "premium material".
Volumetric fog, depth of field and glow are used only when they're grounded and don't obscure information; they can't replace spatial structure and performance.
In a live-action direction, what's protected is the established characters and their skin tone differences; don't push all characters toward the same pink-orange.
Output destination: write the medium controls into the shared style base; the current segment adds only the changes needed this time, avoiding mutually exclusive material languages mixed across segments.

## 7. Choose options through a few style relationships

Applies: the user hasn't set the tone yet and needs distinct, comparable candidates. Prefer proposing two or three directions rather than importing a whole style library.
Each candidate explains how it makes the audience look, which controls it changes and what it protects, rather than just naming a film, brand or filter.

| Candidate relationship | When it fits | Implementation and cost |
| --- | --- | --- |
| Restrained natural layering | The focus is believable behavior and environmental information, and the image shouldn't steal the scene | Rein in the overall cast, keep materials and local differences; relies on composition and action to organize the focus |
| Soft highlights and midtones | You want light or calm viewing, while allowing narrative counterpoint | Reduce glaring highlights and overly hard contrast; key outlines must still be kept, and the image can't wash out overall |
| Limited warm/cool separation | The subject or a specific area needs to be picked out from the environment | Create the difference on existing light colors or the overall hue; don't make every night scene teal and orange |
| A few bright areas with dense shadows | Information hiding, reveal order or strong silhouettes carry the narrative | Specify which information may be obscured and when it is revealed; must not swallow action that has to be seen |

After choosing one main relationship, add a little texture; don't stack fading, heavy grain, strong glow, heavy sharpening and every other effect at once.
Style names only help communicate a direction; what's actually used for execution is light and dark, color separation, materials and visible results.
The same relationship can serve opposite emotions; a warm, bright image can carry unease, and a cool space can hold intimacy.
Output destination: the concise style base the user adopts and its allowed range of adaptation; unadopted candidates don't get mixed into the final prompts.

## 8. Keep things stable within a scene and change between scenes only with grounds

Applies: multi-segment generation, camera changes within a scene, day-to-night transitions, or subjective visual changes in the story.
First fix the common base: medium texture, overall color relationships, light-dark range and asset protection; then establish the necessary adaptations by actual day or night and interior or exterior.
The same location in the same time state inherits the same base; sub-areas and reverse shots don't start a new style.
What's unified across scenes is the relationships and the treatment, not the same white balance, brightness or shadow color in every scene.
When a change is truly needed, write "trigger → start state → visible process → end state → scope of impact", distinguishing real light-source events from subjective expression.
Major subjective color shifts are confirmed as specific design proposals; don't use "intentional rupture" to skip narrative grounds, and don't add editing transitions just for style.
Adjacent generated segments are checked against the actual adopted results for brightness, warmth, shadows and light-source state, not just against planned parameters.
Output destination: segment start and end states and necessary shared constraints; only the currently affected segments need adjusting.

**Teaching example**: the same corridor is split into two segments; in the first, the character walks under a red emergency light, and in the second, goes on to open a door.
The second segment's start state keeps the red light influence already present at this spot and the body position; don't reapply the neutral lighting from the corridor entrance, and don't let the door's base color turn red.
If the emergency light then goes out, note the event and the remaining light sources; state separately how the light-source change and the post base are each maintained.

## 9. Merge into the prompt and check the actual result

The final segment first defines the assets and the current space, then writes the necessary light-source events, and finally merges in a brief color and material look.
Write only the controls needed now, for example "neutral and slightly cool, low-saturation background, the receipt in hand stays discernible, shadows keep the cuff edges".
Negative constraints only block drift that has been identified; don't ask for a silhouette while also writing "all characters' faces always clear".
Acceptance checks the viewing focus, asset recognition, materials, light-source relationships and continuity with adjacent segments against media that can actually be viewed.
A complete design record doesn't mean the output passes; parts that can't be viewed or heard follow the verification limits of the main flow.
When a problem is found, first locate the layer: a wrong base color means fixing the asset, a wrong direction means checking the spatial lighting, a wrong overall cast means adjusting the style; don't redo all the designs at once.

# Deriving Visual Design from Story Facts

Use when a character's appearance is still incomplete, a space is hard to use for action, a key prop's structure is unclear, or a sequel needs its states checked.
When existing assets are enough to complete this shoot, reuse them directly; this method does not require filling in character biographies, a standalone concept book or unused views.
Write conclusions into the corresponding entries in [Asset Production](../assets.md). After entering Seedance PART A, this method supplies asset/spatial anchors only when A1.2/A4 explicitly needs a design proposal, and does not define shots, performance or prompt structure.
For deriving color, how materials take light and the final look, see [Color and Light](colorAndLight.md).

## 1. Separate facts, constraints and proposals first

The entry point for design is what this story needs the audience to recognize and what characters actually need to do, not filling in every person's appearance fields first.
Derive item by item following "existing facts → current action constraints → necessary visible proposals"; confirmed content is not overridden by aesthetic preference.

| Layer | What to look for in the material | How to use it |
| --- | --- | --- |
| Facts | Stated age or growth stage, appearance, clothing, objects, injuries, spaces and events | Inherit directly, keeping the source and the state it applies to |
| Constraints | Era, region, medium, identity relationships, mode of action, limits of ability | Rule out incompatible options; don't expand constraints into new backstory |
| Proposals | Silhouette, structure, color scheme and materials that must be added for recognition, action or production | Mark them as design proposals with reasons; they must not add abilities, secrets or plot clues |

First pull out the definite items, then list the gaps that will affect this installment's images, and design only for the latter.
A line like "she keeps watch on the platform" can't yield her occupation, hometown or backstory; within the allowed design scope you can add clothing suited to the weather in that scene.
When necessary identities, headcounts or key functions conflict, preserve the discrepancy; an ordinary button style doesn't need escalating into a plot clarification.
A short one-line rationale per design item is enough, for example "short hem: allows the climbing already written; design proposal".
Output destination: appearance or structural anchors, items to keep and allowed variation in the asset entry; don't stuff the whole derivation into the generation prompt.

## 2. How a character's function becomes their look

Applies: a new character lacks a visible form, or an existing look hinders plot action, identity recognition or telling characters apart within a scene.
First describe the character's function in the current story in one sentence, for example "leads the way, but refuses to hand over the key"; don't decide looks by good guy versus bad guy.
Then design in the following order; each later step must account for the needs of the step before it.

1. **Behavioral needs**: does the character need to run, climb, hide, sit for long periods or do fine manual work; check whether hems, cuffs, footwear and carrying positions allow it.
2. **Recognition at a distance**: first set body proportions, silhouette, hairstyle or head features, so the character is still recognizable at common shot sizes.
3. **Recognition up close**: choose a few stable facial, skin or hair/fur features; don't build identity by piling on jewelry or scars.
4. **Identity and environment**: clothing layers, craftsmanship and signs of wear match the known era, way of life and local environment.
5. **Relationships within a scene**: look at characters who often share the frame, and check whether silhouettes, mass, value or color blocks get confused.
6. **Medium fit**: 2D keeps clear silhouettes and color blocks; stylized 3D emphasizes volume and material differences; a live-action direction considers believable cut and fit.

You don't need to enlarge the silhouette, raise saturation and add accessories all at once every time; usually improve the one item that most affects recognition first.
Personality constrains choices and behavior and doesn't directly equal physical features; cautious doesn't have to mean thin, tough doesn't have to mean square-jawed.
People in the same occupation can share fabrics and craft, then be distinguished by build, how they wear things or where the wear shows, avoiding everyone getting an unrelated style.
Stable parts of habitual behavior that the material supports can stay in the character description; momentary tension, glaring or bending over belong to shot performance.
Output destination: identity anchors, clothing structure and fixed carried items in the character's base state; a concise visible description goes into the asset prompt.

**Teaching example**: the screenplay only confirms "an elderly clockmaker who has to squeeze into the clock tower's narrow access hatch, with a tool pouch at the waist".
You can propose a short, well-fitted outer coat, cinched cuffs and a close-fitting tool pouch; the tool pouch stays in its specified position, and you don't add a mechanical prosthetic hand on account of the occupation.
Recognition anchors could be a broad nose bridge and gray hair combed back, but both are marked as proposals; don't fill in a fictional "wounded on the battlefield" backstory.
The misuse is writing "mysterious master" first and then piling on a cape, a glowing crest and a big weapon, so the action can't be performed and the identity has been changed without authorization.

## 3. Base state and cumulative variants

Applies: costume changes, ongoing injuries, visible soiling, body changes or the loss of a fixed carried item will affect later recognition.
The base state is the state the character actually enters this story in; it is not necessarily healthy, clean or intact. A returning character can enter from the variant adopted last time.
Track "original state → triggering event → new state → duration" in story order; only events or explicit settings permit change.

| Check item | Differences to spell out | Usually still belongs to the shot |
| --- | --- | --- |
| Body and appearance | Which part, what change, how much, whether it persists | Frowning, turning the head, breathing and brief expressions |
| Clothing | Which garment, which part, the result of changing or soiling | Hems swinging with movement, creases from sitting down |
| Fixed carried items | Which item is added, lost or damaged, and the visible result | The same item changing hands, being raised, briefly blocked |

For each variant, first determine which state the actual reference image is in, then write the complete set of differences in effect relative to that reference.
When referencing the base state, include injuries and damage from before that are still in effect; when referencing the latest variant, state explicitly which changes are inherited.
After writing the differences, list a few invariants; "clothing unchanged" can't cancel an explicit costume change in this installment, and soiling can't be used as a pretext to redraw the face.
One asset image represents only one state; don't mix before and after an injury, or two outfits, into one base sheet.
Adjacent state intervals with completely identical appearance can be merged and reused; you don't need to generate one image per scene.
Output destination: the state and applicable scenes in the asset table, and variant prompts; the triggering action and the state switch point go into the segment's start and end states.

**Teaching example**: in Scene 2 the left sleeve tears, in Scene 4 the badge falls off, and only in Scene 6 does the character change clothes.
If Scenes 4–5 reference the base image, write "left sleeve tear kept, chest badge already missing"; don't just remove the badge while restoring the sleeve.
The change of clothes in Scene 6 can remove the clothing damage, but it cannot automatically heal the wound on the back of the hand that exists at the same time.

## 4. Crowds: shared rules and necessary differences

Applies: multiple people appear as a group and together give the image its force, or a large crowd needs a stable range of looks.
First judge from the screenplay whether it's one unnamed person, a small group of definite size, or a larger crowd; unnamed doesn't mean crowd.
First record the story's headcount or scale, then separately record the number of samples adopted for design; neither substitutes for the other.
For group design, set the shared items first: affiliation, era of dress, materials and craft, color range, and relationship to the main subject.
Then pick samples that cover real differences: age or growth stage, build, role-specific clothing and so on; when differences are insufficient, don't force more characters.
When members of a definite small group each have independent actions or need sustained recognition, give them stable identifiers and the necessary individual assets.
Samples for a large crowd only define the allowed range of looks; the three people in the samples must not become the story's entire headcount.
Visual layering can form a whole through similar color blocks and simplified detail, but don't erase key crowd actions the story requires just to make the protagonist stand out.
Output destination: group rules, samples and headcount notes in the asset entry; the video prompt separately states the actual headcount and members' actions for that segment.
Misuse: collapsing "six escorts" into "one typical guard", or inventing names and short bios for every background pedestrian.

## 5. A scene needs a spatial master before framing areas

Applies: the same location is used multiple times, framing gets closer, characters move across areas, or existing concept art only looks good but can't support the plot.
The spatial master fixes the complete boundaries, structure and relationships of the location; a sub-area only selects a part already present in the master.
Changes in scene number, camera position and composition don't automatically create a new space; separate rooms also shouldn't be forcibly merged just because they're in the same building.

1. List the entering, staying, interacting and leaving that must happen in this scene, and find the tasks the space carries.
2. Fix the space with stable anchors: entrance, window, counter, stairs, terrain boundary; give multiple doors and windows distinguishable names.
3. Describe the anchors' adjacency, relative position, connectivity and height differences, then place ordinary furnishings, keeping necessary quantities and scale relationships.
4. Check the main action path and interaction space; don't let furniture block a required route, and don't conjure up a door to make camera moves convenient.
5. Name parts of the same master as sub-areas, recording their boundaries, parent state, inherited furnishings and necessary information unique to them.
6. Record a separate state only when damage, moved furnishings or weather effects actually happen; objects outside the frame continue to exist.

Express relationships as "the entrance faces the counter, there is a long table under the side window, and between the table and the counter two people can pass each other"; use left and right without a reference sparingly.
When relative scale is enough to execute, don't invent engineering dimensions; dimensions, proper names and necessary geographic relationships already given by the screenplay must still be kept.
A sub-area boundary is not a new wall; a close shot under the window can't swap the original long table for a more photogenic round table.
Output destination: spatial anchors, master and sub-area relationships, and states in the scene entry; full inheritance relationships can remain as text and don't automatically create new image tasks.

**Teaching example**: a station waiting hall contains the area in front of the ticket window and the bench area, and two scenes take place in these two areas respectively.
Both inherit the same hall's entrance, ticket window and bench placement; the enclosed duty room has its own boundaries and structure, and only then is it judged an independent space.
"The bench area gets closer" only changes the framing; "the benches are pushed to the side wall" changes the spatial state, and later wide shots must carry that result forward.

## 6. From movement paths to the visible space in the composition

Applies: when writing a self-contained environment master view, or confirming whether a shot can see the action, exits and clues.
Walk the character's path in text first: which anchor they start from, where they pass, where they stop, and what they come into contact with.
Then choose an observation position that shows the main activity area and stable landmarks, stating the viewing relationship, such as "from the entrance looking toward the ticket window".
The foreground helps lead into the space, the midground carries the main action, and the background shows boundaries or exits; not every image needs all three layers stuffed with decoration.
Distinguish "must exist" from "must be visible in this image": the area behind a door can be occluded, but later uses must not claim its details were verified in the image.
When a necessarily hidden area isn't defined yet, add a text proposal; don't make overlapping walls see-through to show everything in one image.
After the camera reverses direction, screen left and right change, but the anchors' physical relationships stay the same; moving the camera can't move window light or furniture.
The default environment asset is one self-contained, environment-only master view; the prompt spells out all required spatial relationships, rather than just "same master".
Images don't include characters, human figures or story animals; character placement and behavior are realized in video by referencing real character assets.
Output destination: the asset master-view prompt records only visible structure and spatial anchors. If used for Seedance, camera position, occlusion, eyelines and screen direction are all handled by PART A A5/A7/A9 of the main `SKILL.md`; this method must not write them separately.
Misuse: altering the building's structure so two entrances fit in frame at once, or turning every camera change into a four-direction supplementary image task.

## 7. Key props: from function to form

Applies: the plot relies on an object to convey information, trigger events or complete a key interaction, and existing assets don't cover it clearly enough.
First check whether it already belongs to a character's fixed look or the scene's furnishings, and reuse the same design; a standalone enlarged detail must not create a second version either.
An ordinary cup doesn't automatically become a new asset just because it's picked up; whether it's key is judged by its use in this story and the need to reuse it.

1. Extract the confirmed functions: what the audience must recognize, how characters must use it, and which state change drives events.
2. Work backward from the use action to the structure: grip position, opening and closing relationship, connection method, visible information area and necessary scale.
3. Choose materials and craft compatible with the era, environment and operation, distinguishing the main body, connectors and surface finish.
4. Put wear marks where there's reason for them, such as a repeatedly pressed button or a frequently gripped edge; don't scatter scratches evenly everywhere.
5. Spell out the complete state and the necessary changed states, keeping the remaining silhouette, connections and text information consistent.

Write passwords, inscriptions, seals and symbols only when the story already provides them; the contents of an unknown letter can't be filled in as an answer by art design.
Describe materials by visible response: brushed metal keeps a directional grain, coarse cloth leans matte, frosted glass transmits light but can't be seen through clearly.
Avoid treating reflectance percentages of unclear basis as material facts; highlights, transparency and surface roughness can be described clearly without jargon.
An object's color can blend into the environment, echo it lightly or stand out, but its prominence follows the reveal timing and must not expose evidence early that should stay hidden.
Output destination: prop structural anchors and the asset prompt; the holder, opening and closing actions, the handover process and the end position go into the video segment.

**Teaching example**: the story confirms an evidence box that "only lets you take out the note after the side latch is slid open".
First design a recognizable side latch, sliding direction and lid seam, then choose a wooden box with a metal latch to suit the era; don't add a fingerprint lock or mysterious carvings.
If the note's content isn't given, only make sure it can be taken out of the box, and don't write the text for the screenwriter; record the inside and outside states separately.

## 8. Compress the design into a usable asset basis

First delete invisible praise and repeated adjectives, then keep "object identity, recognition anchors, structural relationships, current state, allowed variation".
New character images follow the full head close-up, front full body, right-side 90° full body and back full body; the top of the head, the body and the feet are complete.
Views on the same sheet keep the same identity and state; animals are adapted to their actual design, without adding organs because of the template.
Scenes follow the self-contained single image; props are organized by the default presentation in [Asset Production](../assets.md) or a layout the user has confirmed.
The required aspect ratio is determined by complete presentation and actual capability; don't turn this method into a fixed ratio or model requirement.
Finally check backward against the story: characters can perform the action, scenes can be walked through, props can be used, and the audience can recognize them when needed.
Bring only necessary conclusions into the prompt; after an image is adopted, check its actual identity, structure and state again, and don't treat design intent as already realized in the image.

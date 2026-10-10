# State, Revision, and Delivery

> **Seedance usage boundary:** This file only records versions, real generation results, adoption, and delivery. It cannot rewrite the prompt rules already set in PART A of the main `SKILL.md`; any Seedance prompt revision must return to PART A.

Multi-stage or multi-round production uses one concise state file and one canvas overview text node. Prefer the project's existing ledger and its exact path, including the legacy `production-state.md`; a new project may use `productionState.md`, and multiple episodes are saved in their own subdirectories within the project. Simple single-item text tasks do not require setting up a full production state.

The state file records facts and indexes; the overview shows only the current scope, valid results, progress, gaps, and next step. Professional body text stays in its own text nodes and is not copied into the whole ledger. Add records only when actual results exist; do not pre-build many empty tables or empty folders.

## The minimum to record

```markdown
# Production state

Goal and scope of this task:
Current canvas and state file path:
Source script or original text version, adopted scope:
Current stage, authorized continuous production scope, pending items:

## Results
| ID | Purpose/scene | Version | Canvas/node | Current body text or media path | Pinned adopted version | Input dependencies | Status and basis for confirmation |
|---|---|---|---|---|---|---|---|

## Generation attempts
| Local attempt ID | Asset/segment, node | Prompt snapshot | Model and full effective parameters | Reference files, versions, order, and purposes | Output before the call | Authorized scope and remaining runs | Return and actual file |
|---|---|---|---|---|---|---|---|

## Segment adoption
| Segment and story scope | Video and generation attempt for this run | Adoption decision and intended range | Actual end state and its source | Items the Agent checked / did not check | Downstream dependencies |
|---|---|---|---|---|---|

## Delivery
Actual delivered files and index:
Generated / adopted / composited / collected scope:
Gaps and inputs needed to continue:
```

Use the fields the task needs; you do not have to fill every table each time. Production style, audio plan, and specifications can go in the brief and be indexed here. An attempt ID is a local record and cannot be treated as a task ID the host did not return. Any path claimed to exist must come from an actual read, write, or node return.

## A confirmed version cannot point only to mutable body text

When preparing to submit for review, save an independent historical snapshot of that version's body text and show that specific version; the user's confirmation binds to this snapshot. When the user has explicitly designated a finalized original text, that original may be pinned directly. A snapshot serves only as a historical basis, is never edited in both directions, and is not saved only right before the Agent makes changes.

After receiving confirmation, re-read the current node. If the user changed the body text while you were waiting, the original confirmation still corresponds to the submitted version and does not also approve the later content; list the differences and handle them according to the user's intent, keeping the historical snapshot unchanged. When an existing confirmed file has no snapshot, first compare it with whatever confirmed content is available; mark history that cannot be restored as "version basis pending verification", and never pass the current file off as the old version.

Existing read-only history files may be reused directly. Ordinary read/write tools cannot guarantee that the user can never modify a snapshot, so check it the same way when a read reveals an inconsistency. When there is no usable file writing but an independent text node can be kept, keep the original node and create a separate candidate, recording the nodes and actual paths separately; when history cannot be saved, do not overwrite body text that is still adopted, and state the specific limitation.

Before generation, save a snapshot of the actual complete prompt, parameters, references, and authorization; later edits are not written back to this attempt. Keep prompt versions separate from result versions: changing the text does not mean the old video was generated from the new text. For the re-check right before execution see [Canvas Execution](canvasExecution.md).

## Adopted media and partial revisions

Mount adopted files on independent material nodes, recording the actual path and purpose. To revise an image or video, use a new candidate generation node, and after adoption update only the downstream items that truly need the new version; keep the old adopted files, nodes, prompts, and historical relationships, and do not switch segments that still depend on the old result ahead of time.

For each change, trace the impact along the actual input dependencies: character appearance affects the segments that use that state, dialogue affects the capacity and lip sync of the corresponding segment, and space or action affects adjacent boundaries. Unaffected results remain valid. When the new version is compatible, only update the correspondence; when regeneration is needed, state the affected scope and the specific plan.

When handling real Seedance feedback, use A8, A11.4, A12.18.1, and the corresponding A0–A12 clauses in PART A of the main `SKILL.md` to locate problems with references, action, space, audio, performance, light and color, props, and image breakdown; when the prompt needs changing, return to the affected items in PART A. **Never call a separate shot or performance method to build a second set of revision rules.** Do not handle every problem by adding adjectives, redesigning assets, or re-running the whole film.

Old assets the user has explicitly adopted are reused directly; do not require new images for a new template. When there is no ledger, rebuild the known index from the materials the user specified and the live canvas; write "unknown" for unknown confirmations, generation parameters, or sources, and never guess by a name like "final", modification time, or the highest version number.

## Verification and adoption

When reading an image, check identity, quantity, necessary views, costume and objects, environmental relationships, and readable text. A tool succeeding alone does not prove the image meets the requirements; suitable material the user has explicitly accepted does not need to be adopted again.

For video, check story, dialogue and speakers, OS/VO, identity and who is present, physical contact in actions, held objects and spatial continuity, audio, and output specifications; also check actual generation glitches: drift in a character's face, hairstyle, or costume; extra or missing limbs or fingers; hands fused with faces; characters or props clipping through each other; key props flashing, vanishing, duplicating, or switching hands; sudden changes in size or structure; melting product packaging structure; and erroneous duplicates in mirrors, glass, or shadows. For consecutive segments, first judge under A8 of the embedded PART A whether they are really connected: only when they are connected, compare characters' world positions, poses, facing, held objects, and environmental state; when they are not connected, verify only the current segment. The scope of checking depends on this round's real capability: a file path, a player, a file's existence, or a still frame does not prove the Agent watched the whole video or heard the audio track. For videos the user uploads, also confirm that the actual model or tool can read them; do not assume an attachment means review is done.

When there is no video reading capability, ask the user to preview the current result and report obvious problems, whether to adopt it, and the end state the next segment truly depends on. Record "adopted after user preview" and the items the Agent did not verify; do not ask for an unrelated quality questionnaire. The adoption decision, problem feedback, and end state can be obtained in the same reply.

Consecutive segments need an actual basis: character positions and facing, held objects and progress of actions, events that have happened, changes in appearance, and continuing sounds. Use a viewable video, a real continuity frame, or user feedback; do not pass the planned end state off as the actual end state. Write them as explicit initial facts for the next segment; when the current result is wrong, handle the current segment first, and do not escalate a glitch into new story.

Extract frames or attach earlier media only when truly needed and the tools support it; do not ask the user for useless extra screenshots for the sake of the process. Segments with no spatial or temporal dependency may proceed according to the confirmed plan and specific batch authorization, with results still verified and adopted separately.

## Deliver according to what was actually completed

- Text only: deliver the current text, the corresponding nodes or real files, and the necessary gaps.
- Segmented video: deliver the adopted segments, their order, the actual generation basis, intended ranges, and gaps. The sum of generated material durations is not the measured duration of an edited final cut.
- A single final cut: do this only when editing, trimming, mixing, or export tools are actually provided and the user has authorized it; otherwise state what post-production is still needed, and do not call two material links a complete final cut.
- Delivery directory: copy adopted material into the target directory in the project and verify it only when real binary copying capability exists. A plain text `write` cannot copy images or videos; when capability is insufficient, deliver an index of source files and mark them as pending collection.

Collection keeps the originals; when old delivered content differs, use a new version directory to avoid mixing in rejected material. Reuse unchanged, already verified deliveries directly without copying them again and again. Default delivery does not include publishing, uploading, or cleaning up source files; do these according to the actual scope the user separately specifies.

The final reply states what was made, where the real nodes/files are, which content was verified by whom, and the single necessary next step. Record all-segments adoption, final-cut compositing, and directory collection separately and truthfully; do not mark every status complete just because the overview or list is complete.

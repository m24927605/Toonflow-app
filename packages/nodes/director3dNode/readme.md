# 3D Director's Studio

Generates scenes, model animations, and camera moves from text, then lets you adjust shots by framing them in 3D; well suited to previsualizing action and camera work. Humanoid characters use the built-in low-poly jointed mannequin, and sets and props can use basic geometry.

## Inputs and outputs

- Inputs accept text, image, and video references that describe or illustrate the scene, motion, and camera moves.
- Keyframes can be exported as PNG image nodes, and the selected animation can be exported as an MP4 video node.
- Exporting requires the corresponding Image or Video node plugin to be enabled.

## Usage

The first time you open the Director's Studio, a guided tour is shown; once you finish or close it, it no longer appears automatically.

1. Click the node preview to open the Director's Studio, choose a generation model, describe the scene, character actions, and shot requirements, and click "Generate animation".
2. Choose a variant from the animation list to preview its motion and camera moves from the start and view the prompt it was generated from. Pause or seek with the play button and progress bar, and keep entering requests to generate new variants. If an older variant did not save its prompt, the panel states clearly that the record is missing.
3. Click the 3D view to enter framing mode and use the mouse to change the viewing direction; WASD moves, Space rises, Shift descends, and the scroll wheel adjusts the focal length.
4. Right-click to record a framing, or click "Add keyframe". Keyframes can be dragged to reorder, clicked to review, or deleted. Left-click or Esc exits framing mode.
5. After recording keyframes, generate the animation again so the camera moves follow these framings and their order.
6. Adjust the aspect ratio, grid, sky, and lighting as needed, then export keyframe images or click "Export video node".

Keep the current window visible while a video is exporting; when it finishes, view the result in the new video node created on the canvas.

## AI partial editing

Generating a variant calls `ai.generate()` in the same way as the regular text node, passing the private `readDocument` / `editDocument` tools through `tools`; the selected text model must support tool calls. Each round first copies the selected variant as a draft, and the AI reads and partially modifies the scene, tracks, and camera as needed, keeping whatever it does not change; the first generation also fills in the draft through the same tools. The tool loop and the draft both live on the node side; the server only proxies individual model requests and keeps no Director's Studio session.

The tools are not registered in `nodeTools`, are not exposed to the external main Agent, and do not operate on files directly. A new variant is appended only after full validation, preview rendering, and saving all succeed; the scene itself is still shared by all variants. On failure, cancellation, or a concurrent scene conflict, the draft is not committed. Each generation calls the model at most 40 times, and a single model call is cancelled after 10 minutes.

## Low-poly jointed mannequin

In the Director's Studio "Settings", click "Add mannequin" to add a low-poly jointed mannequin and save it. The mannequin uses reduced mesh subdivision, shows no extra joint spheres, and keeps 16 joints internally. You can also simply ask the AI to use the built-in mannequin instead of assembling a human body from scratch.

The mannequin is about 1.8 units tall with its origin at the soles of its feet; +Y points up and +Z forward. Left and right follow the mannequin's own perspective, so +X is its left. The root object's position, rotation, and scale control its overall position, orientation, and size; material.color sets one uniform color for the whole mannequin, so different characters can use different colors.

A mannequin occupies a single objectList item in the scene:

```json
{
  "threeJsonId": "person1",
  "name": "Person",
  "objType": "mannequin",
  "geometry": {},
  "position": { "x": 0, "y": 0, "z": 0 },
  "material": { "type": "standard", "color": "#c8a878", "roughness": 0.7 },
  "pose": { "rightElbow": { "x": -1.2, "y": 0, "z": 0 } }
}
```

pose can be omitted; the default zero rotation is a natural standing pose with the arms hanging down. Joint poses use XYZ Euler angles relative to the parent joint, in radians. The hierarchy is hips → spine → neck → head; under spine are the left and right shoulder → elbow → wrist chains, and under hips are the left and right hip → knee → ankle chains. Rotating a shoulder moves the whole arm, and rotating a hip moves the whole leg.

Available joint names: hips, spine, neck, head, leftShoulder, leftElbow, leftWrist, rightShoulder, rightElbow, rightWrist, leftHip, leftKnee, leftAnkle, rightHip, rightKnee, rightAnkle.

The mannequin is complete by default. Add a hiddenParts array on request to hide the given joints and everything below them. For example, `"hiddenParts": ["leftShoulder", "rightKnee"]` removes the left arm and the right lower leg (including the foot). Shoulder is the whole arm, Elbow the forearm including the hand, and Wrist the hand only; Hip is the whole leg, Knee the lower leg including the foot, and Ankle the foot only. Use the matching left/right joint names, with left and right from the mannequin's own perspective. Hidden parts keep their skeleton names, so existing animations still work.

An animation's objectId always points to the mannequin's root ID. Use joint to select a joint; frames contain only rotation, and bone lengths stay fixed. For example, a track that bends the right elbow:

```json
{
  "objectId": "person1",
  "joint": "rightElbow",
  "frames": [
    { "time": 0, "rotation": { "x": 0, "y": 0, "z": 0 } },
    { "time": 1, "rotation": { "x": -1.2, "y": 0, "z": 0 } }
  ]
}
```

Tracks without joint control overall movement, rotation, or scaling and can be combined with joint tracks; position and scale can be omitted from the root track to keep the base model's transform. All tracks must still fit the variant's duration and the keyframe format.

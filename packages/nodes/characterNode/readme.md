# Character Identity Node

Trains or selects a Higgsfield character identity (Soul ID) so image generation keeps the same face across shots.

## Inputs and outputs

- The training image input takes 5–20 photos of the same real person; 8–12 is recommended. Photos without a human face fail training.
- Outputs the character identity once training has completed. Connect it to an image generation node that uses Higgsfield Soul 2.0 or Soul Cinematic, matching the version the identity was trained for.

## Usage

1. Sign in to the Higgsfield CLI on the computer running Toonflow (see the Higgsfield provider in the main README).
2. To reuse an identity, select the node and pick it from "Existing character". Only identities that finished training can be picked.
3. To train a new one, connect the photos, enter a name, choose the version and click "Train". Each training run uses Higgsfield credits and takes a few minutes; the node checks the status every 15 seconds and outputs the identity when it completes.

## Photo guidelines

- Angles: 4–6 front views, 1–2 at 45° to each side, 1 full profile on each side, and optionally 1 slightly tilted up or down.
- Quality: a sharp, unblurred face with even lighting; avoid strong backlight or harsh shadows.
- Expressions: a mix of smiling, neutral and lightly speaking.
- Avoid sunglasses, hats covering the face, and heavy retouching or filters.

Higgsfield keeps trained identities in your account; this node does not delete them.

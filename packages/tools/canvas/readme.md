# Canvas Operations

Lets the Agent directly operate the canvas open in a project to build and organize node workflows.

## How to Use

First open the target project's canvas, then describe to the Agent what you want done.
For example: "Tidy up the current canvas", "Add a text node with this storyboard", "Connect this reference image to the video generation node".
The Agent first reads the actual nodes and available capabilities, then performs the operation; existing nodes can be reused.

## Features

- Create, switch, and rename canvases.
- Add nodes; move, rename, select, and delete nodes in batches, handling several nodes at once.
- Connect compatible node ports in batches, and delete specified edges in batches.
- Automatically tidy the whole canvas based on node sizes and edges, or adjust the view to show specified nodes.
- Call functions provided by nodes, such as editing text, setting prompts, or generating media; what is available depends on what each node supports.

The target canvas must remain available. The node types you can add depend on the node plugins currently installed, and edges must also satisfy the nodes' input requirements.
After a node generation task starts, you still need to wait for the actual result; tidying the canvas does not trigger generation.
This tool has no configuration items and does not need a separate API key; configuration needed for media generation is provided by the corresponding provider.

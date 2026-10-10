# Storyboard creation team

A local team example: director coordinates, writer writes and reviewer reviews. Members can divide the work through the team's delegation capability; all members use only the read capabilities granted to them, and this example does not run compute-consuming media generation tasks or write to the workspace automatically.

team.json declares the members, delegation relationships and resource access scope. members holds the prompts, skills/storyboard holds the team's private skills, and knowledge holds private knowledge. Private means they are not registered in other teams' resource directories; it does not mean the content is hidden from users of this machine.

Run `bun run build` to generate the build/agents/storyboardTeam directory and storyboardTeam.agent.zip. In the development environment, the first build can install it to data/agents/storyboardTeam; when that directory already exists, all changes in it are kept by default. When you are sure you want to fully replace the development installation copy with the source, use `NODE_ENV=dev bun run build --sync`; this command deletes files in the installation copy that no longer belong to the source.

For external A2A access, the host provides the address, authentication, model and workspace. The team package itself contains no keys and does not listen on any port.

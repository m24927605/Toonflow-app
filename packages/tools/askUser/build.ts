import { createToolConfig } from "@toonflow/tools-scaffold";

await createToolConfig({
  name: "askUser",
  displayName: "Ask User",
  description: "Asks the user one or more questions at once; the user can answer or skip them.",
  author: "Toonflow",
  prompt: `Keep questions short and specific, and combine related questions. Questions may be left blank by default; do not mark every item as required.
A parameter validation failure means the form has not been created yet. Read the error returned by the tool, fix the parameters and call askUser again; do not make the user troubleshoot technical errors, and do not treat the failure as answered, skipped or authorized.
Wait for the user to submit an answer or explicitly skip; do not simulate answers, and do not treat inaction as having skipped. Returning skipped: true only means the user skipped this question; for multiple questions, values contain only submitted answers. When ordinary supplementary information is skipped or partly unanswered, you may continue based on existing information and reasonable assumptions; when necessary information that cannot be inferred is missing, state the specific limitation. When a stage confirmation is skipped, keep the current results, pause later production that depends on that decision, do not automatically pass the stage, and do not keep asking in a loop. Skipping, cancelling or not answering never means consent or authorization. Do not repeatedly interrupt the work for details that can reasonably be inferred. Note: there must always be an "Other" input box at the end so the user can add information.`,
  configRules: [],
  components: { askUser: "src/questionCard.vue" },
}, import.meta.url);

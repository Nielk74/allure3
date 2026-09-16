export { applyAllureCiEnv } from "./ciEnv.js";
export { detect } from "./detect.js";
export { isLocalCiDescriptor } from "./detectors/local.js";
export type { GitlabCiDescriptor } from "./detectors/gitlab.js";
export { restoreGitlabHistory, upsertGitlabJobNote } from "./helpers/gitlab/index.js";
export type { GitlabIntegrationOptions, GitlabOperationResult, GitlabReportSummary } from "./helpers/gitlab/index.js";

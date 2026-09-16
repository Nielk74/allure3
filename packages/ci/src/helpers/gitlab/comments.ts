import { gitlab } from "../../detectors/gitlab.js";
import { createGitlabClient, type GitlabClient } from "./client.js";
import type { GitlabIntegrationOptions, GitlabOperationResult, GitlabReportSummary } from "./types.js";

const MARKER_VERSION = "v1";
const MAX_NOTE_SCAN_PAGES = 5;
const NOTE_PAGE_SIZE = 100;
const MAX_COMMENT_LENGTH = 60_000;

const skipped = (reason: string): GitlabOperationResult => ({ status: "skipped", reason });

const warnSkipped = (warn: GitlabIntegrationOptions["warn"], reason: string) => {
  warn?.(`GitLab summary note skipped: ${reason}`);
};

const isDecimalString = (value: string): boolean => /^[0-9]+$/.test(value);

const encodePathSegment = (value: string): string => encodeURIComponent(value);

const ownershipMarker = ({ jobName, pipelineId, jobId }: ParsedMarker): string =>
  `<!-- allure-gitlab-summary:${MARKER_VERSION}:${jobName}:${pipelineId}:${jobId} -->`;

type GitlabNote = {
  id: string;
  body: string;
};

type ParsedMarker = {
  jobName: string;
  pipelineId: bigint;
  jobId: bigint;
};

const parseNotes = (value: unknown): GitlabNote[] => {
  if (!Array.isArray(value)) {
    throw new Error("invalid notes response");
  }

  return value.map((note) => {
    if (typeof note !== "object" || note === null) {
      throw new Error("invalid notes response");
    }

    const { id, body } = note as { id?: unknown; body?: unknown };
    const textId = typeof id === "number" && Number.isInteger(id) ? String(id) : typeof id === "string" ? id : "";

    if (!textId || typeof body !== "string") {
      throw new Error("invalid notes response");
    }

    return { id: textId, body };
  });
};

const markerPattern = new RegExp(
  `^<!-- allure-gitlab-summary:${MARKER_VERSION}:([A-Za-z0-9+/]+={0,2}):([0-9]+):([0-9]+) -->\\n`,
);

const parseMarker = (body: string): ParsedMarker | undefined => {
  const match = body.match(markerPattern);

  if (!match) {
    return undefined;
  }

  return {
    jobName: match[1],
    pipelineId: BigInt(match[2]),
    jobId: BigInt(match[3]),
  };
};

const compareLogicalRun = (left: ParsedMarker, right: ParsedMarker): number => {
  if (left.pipelineId > right.pipelineId) {
    return 1;
  }

  if (left.pipelineId < right.pipelineId) {
    return -1;
  }

  if (left.jobId > right.jobId) {
    return 1;
  }

  if (left.jobId < right.jobId) {
    return -1;
  }

  return 0;
};

const currentMarker = (client: GitlabClient): ParsedMarker => ({
  // Notes are already scoped to the project and MR; encode the exact name to keep HTML comments safe.
  jobName: Buffer.from(client.ci.ciJobName).toString("base64"),
  pipelineId: BigInt(client.ci.jobRunUid),
  jobId: BigInt(client.ci.currentJobId),
});

const notePath = (client: GitlabClient, iid: string, page?: number): string => {
  const base = `/projects/${encodePathSegment(client.ci.projectId)}/merge_requests/${encodePathSegment(iid)}/notes`;

  return page === undefined ? base : `${base}?per_page=${NOTE_PAGE_SIZE}&page=${page}`;
};

const readOwnedNotes = async (
  client: GitlabClient,
  iid: string,
  currentJobName: string,
): Promise<{ notes: { note: GitlabNote; marker: ParsedMarker }[]; complete: boolean }> => {
  const notes: { note: GitlabNote; marker: ParsedMarker }[] = [];
  let page = 1;

  for (let index = 0; index < MAX_NOTE_SCAN_PAGES; index += 1) {
    const { data, headers } = await client.requestJson<unknown>("GET", notePath(client, iid, page));

    for (const note of parseNotes(data)) {
      const marker = parseMarker(note.body);

      if (marker?.jobName === currentJobName) {
        notes.push({ note, marker });
      }
    }

    const nextPageHeader = headers.get("x-next-page");

    if (nextPageHeader === null) {
      return { notes: [], complete: false };
    }

    const nextPage = nextPageHeader.trim();

    if (!nextPage) {
      return { notes, complete: true };
    }

    const expectedNextPage = String(page + 1);

    if (!isDecimalString(nextPage) || nextPage !== expectedNextPage) {
      return { notes: [], complete: false };
    }

    page += 1;
  }

  return { notes: [], complete: false };
};

const selectNewestOwnedNote = (notes: { note: GitlabNote; marker: ParsedMarker }[]) =>
  notes.reduce<{ note: GitlabNote; marker: ParsedMarker } | undefined>((selected, candidate) => {
    if (!selected || compareLogicalRun(candidate.marker, selected.marker) > 0) {
      return candidate;
    }

    return selected;
  }, undefined);

export const upsertGitlabJobNote = async (
  options: GitlabIntegrationOptions & { summary: GitlabReportSummary; reportUrl: string },
): Promise<GitlabOperationResult> => {
  const iid = gitlab.pullRequest?.id;

  if (!iid || !isDecimalString(iid)) {
    warnSkipped(options.warn, "missing merge request");

    return skipped("missing merge request");
  }

  if (gitlab.projectId && gitlab.mergeRequestProjectId && gitlab.mergeRequestProjectId !== gitlab.projectId) {
    warnSkipped(options.warn, "cross-project merge request");

    return skipped("cross-project merge request");
  }

  const client = createGitlabClient(options);

  if (!client) {
    return skipped("gitlab unavailable");
  }

  if (!client.ci.currentJobId || !isDecimalString(client.ci.currentJobId)) {
    warnSkipped(options.warn, "missing current job");

    return skipped("missing current job");
  }

  const current = currentMarker(client);
  let reportUrl: URL;

  try {
    reportUrl = new URL(options.reportUrl);

    if (
      (reportUrl.protocol !== "http:" && reportUrl.protocol !== "https:") ||
      reportUrl.username ||
      reportUrl.password
    ) {
      throw new Error("invalid report URL");
    }
  } catch {
    warnSkipped(options.warn, "invalid report URL");

    return skipped("invalid report URL");
  }

  const body = `${ownershipMarker(current)}\n${reportUrl.href}`;

  if (body.length > MAX_COMMENT_LENGTH) {
    warnSkipped(options.warn, "comment too large");

    return skipped("comment too large");
  }

  let ownedNotes: { note: GitlabNote; marker: ParsedMarker }[];

  try {
    const scan = await readOwnedNotes(client, iid, current.jobName);

    if (!scan.complete) {
      warnSkipped(options.warn, "incomplete note scan");

      return skipped("incomplete note scan");
    }

    ownedNotes = scan.notes;
  } catch (error) {
    const reason =
      error instanceof Error && error.message === "invalid notes response" ? error.message : "note lookup failed";

    warnSkipped(options.warn, reason);

    return skipped(reason);
  }

  const selected = selectNewestOwnedNote(ownedNotes);

  if (selected && compareLogicalRun(selected.marker, current) > 0) {
    warnSkipped(options.warn, "newer owned note exists");

    return skipped("newer owned note exists");
  }

  try {
    if (selected) {
      await client.requestJson("PUT", `${notePath(client, iid)}/${encodePathSegment(selected.note.id)}`, { body });
    } else {
      await client.requestJson("POST", notePath(client, iid), { body });
    }
  } catch {
    warnSkipped(options.warn, "note write failed");

    return skipped("note write failed");
  }

  return { status: "ok" };
};

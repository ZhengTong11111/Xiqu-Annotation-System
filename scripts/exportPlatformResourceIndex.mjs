#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArguments(process.argv.slice(2));
const baseUrl = requiredArgument(args, "base-url").replace(/\/$/u, "");
const accountName = requiredArgument(args, "account");
const outputBase = path.resolve(requiredArgument(args, "output"));
const password = process.env.XIQU_PASSWORD;

if (!password) {
  throw new Error("XIQU_PASSWORD is required in the process environment.");
}

let accessToken = null;

try {
  const login = await requestJson("/auth/login", {
    method: "POST",
    body: { accountName, password },
    authenticated: false,
  });
  accessToken = login.accessToken;

  const currentUser = await requestJson("/auth/me");
  const rootProjects = await listAllResources({ view: "all_projects" });
  const containerProgress = { completed: 0 };

  process.stderr.write(`Found ${rootProjects.length} top-level projects. Crawling descendants...\n`);
  const projectTrees = await mapWithConcurrency(rootProjects, 4, async (project) => {
    const entries = [];
    const queue = [{ resource: project, resourcePath: project.name, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      entries.push(toIndexEntry(current.resource, {
        rootProjectId: project.id,
        rootProjectName: project.name,
        resourcePath: current.resourcePath,
        depth: current.depth,
      }));

      if (current.resource.type !== "project" && current.resource.type !== "folder") {
        continue;
      }

      const children = await listAllResources({ parentId: current.resource.id });
      containerProgress.completed += 1;
      if (containerProgress.completed % 20 === 0) {
        process.stderr.write(`Listed ${containerProgress.completed} containers...\n`);
      }
      for (const child of children) {
        queue.push({
          resource: child,
          resourcePath: `${current.resourcePath}/${child.name}`,
          depth: current.depth + 1,
        });
      }
    }

    return { project: toIndexEntry(project, {
      rootProjectId: project.id,
      rootProjectName: project.name,
      resourcePath: project.name,
      depth: 0,
    }), entries };
  });

  const resources = projectTrees.flatMap(({ entries }) => entries);
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
  const externalLinkedMediaById = new Map();
  const externalLinkedMediaPromises = new Map();
  const annotations = resources.filter(({ type }) => type === "annotation_file");
  let resolvedAnnotations = 0;

  process.stderr.write(`Resolving media bindings for ${annotations.length} annotation files...\n`);
  await mapWithConcurrency(annotations, 6, async (annotation) => {
    const result = await requestJson(
      `/annotation-files/${encodeURIComponent(annotation.id)}/audio-playback-options`,
      { allowError: true },
    );
    if (result.ok) {
      const mediaResourceId = result.data.primaryMediaResourceId;
      const indexedMedia = resourcesById.get(mediaResourceId) ?? null;
      const media = indexedMedia ?? await loadExternalLinkedMedia(mediaResourceId);
      annotation.annotation.mediaBinding = {
        status: "bound",
        mediaResourceId,
        mediaName: media?.name ?? null,
        mediaPath: media?.path ?? null,
        mediaInIndexedProjectTrees: indexedMedia !== null,
      };
    } else if (
      result.status === 400 &&
      result.error?.message === "标注文件尚未关联主媒体。"
    ) {
      annotation.annotation.mediaBinding = {
        status: "unbound",
        mediaResourceId: null,
        mediaName: null,
        mediaPath: null,
        mediaInIndexedProjectTrees: false,
      };
    } else {
      annotation.annotation.mediaBinding = {
        status: "unresolved",
        mediaResourceId: null,
        mediaName: null,
        mediaPath: null,
        mediaInIndexedProjectTrees: false,
        errorCode: result.error?.code ?? `http_${result.status}`,
        errorMessage: result.error?.message ?? "Unable to resolve media binding.",
      };
    }

    resolvedAnnotations += 1;
    if (resolvedAnnotations % 25 === 0) {
      process.stderr.write(`Resolved ${resolvedAnnotations}/${annotations.length} annotation bindings...\n`);
    }
  });

  const externalLinkedMedia = [...externalLinkedMediaById.values()];
  const summary = buildSummary(resources, externalLinkedMedia);
  const index = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      baseUrl,
      account: {
        id: currentUser.id,
        accountName: currentUser.accountName,
        displayName: currentUser.displayName,
        roles: currentUser.roles,
      },
    },
    scope: {
      rootView: "all_projects",
      includes: "active top-level projects and all active descendants visible to the account",
      excludes: [
        "archived resources",
        "trashed resources",
        "resource file contents",
        "annotation ProjectData payloads",
        "media bytes",
        "playback URLs and credentials",
      ],
      associationSource: "annotation audio-playback-options metadata",
    },
    summary,
    topLevelProjects: projectTrees.map(({ project, entries }) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      descendantCount: entries.length - 1,
    })),
    externalLinkedMedia,
    resources,
  };

  const jsonText = `${JSON.stringify(index, null, 2)}\n`;
  const csvText = toCsv(resources);
  const jsonPath = `${outputBase}.json`;
  const csvPath = `${outputBase}.csv`;
  await mkdir(path.dirname(outputBase), { recursive: true });
  await writeFile(jsonPath, jsonText, { encoding: "utf8", mode: 0o600 });
  await writeFile(csvPath, csvText, { encoding: "utf8", mode: 0o600 });

  process.stdout.write(`${JSON.stringify({
    jsonPath,
    csvPath,
    jsonSha256: createHash("sha256").update(jsonText).digest("hex"),
    csvSha256: createHash("sha256").update(csvText).digest("hex"),
    summary,
  }, null, 2)}\n`);

  async function loadExternalLinkedMedia(mediaResourceId) {
    if (!externalLinkedMediaPromises.has(mediaResourceId)) {
      externalLinkedMediaPromises.set(mediaResourceId, (async () => {
        const media = await requestJson(`/resources/${encodeURIComponent(mediaResourceId)}`);
        const ancestors = [];
        const visited = new Set([media.id]);
        let parentId = media.parentId ?? null;
        while (parentId) {
          if (visited.has(parentId)) {
            throw new Error(`Resource ancestry cycle detected at ${parentId}.`);
          }
          visited.add(parentId);
          const parent = await requestJson(`/resources/${encodeURIComponent(parentId)}`);
          ancestors.unshift(parent);
          parentId = parent.parentId ?? null;
        }
        const resourcePath = [...ancestors.map(({ name }) => name), media.name].join("/");
        const root = ancestors[0] ?? media;
        const entry = toIndexEntry(media, {
          rootProjectId: root.type === "project" ? root.id : null,
          rootProjectName: root.type === "project" ? root.name : null,
          resourcePath,
          depth: ancestors.length,
        });
        externalLinkedMediaById.set(mediaResourceId, entry);
        return entry;
      })());
    }
    return externalLinkedMediaPromises.get(mediaResourceId);
  }
} finally {
  accessToken = null;
}

async function listAllResources(filters) {
  const items = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({
      ...filters,
      sortBy: "name",
      direction: "asc",
      limit: "200",
    });
    if (cursor) query.set("cursor", cursor);
    const page = await requestJson(`/resources?${query}`);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

async function requestJson(
  resourcePath,
  { method = "GET", body, authenticated = true, allowError = false } = {},
) {
  const headers = new Headers({ accept: "application/json" });
  if (authenticated) {
    if (!accessToken) throw new Error("Authenticated request attempted before login.");
    headers.set("authorization", `Bearer ${accessToken}`);
  }
  if (body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(`${baseUrl}${resourcePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.error) {
    if (allowError) {
      return { ok: false, status: response.status, error: payload?.error ?? null };
    }
    const message = payload?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`${method} ${resourcePath} failed: ${message}`);
  }
  if (!payload || typeof payload !== "object" || !("data" in payload)) {
    throw new Error(`${method} ${resourcePath} returned an invalid API envelope.`);
  }
  return allowError
    ? { ok: true, status: response.status, data: payload.data }
    : payload.data;
}

function toIndexEntry(resource, context) {
  const entry = {
    id: resource.id,
    parentId: resource.parentId ?? null,
    rootProjectId: context.rootProjectId,
    rootProjectName: context.rootProjectName,
    path: context.resourcePath,
    depth: context.depth,
    type: resource.type,
    name: resource.name,
    owner: resource.owner ? {
      id: resource.owner.id,
      accountName: resource.owner.accountName,
      displayName: resource.owner.displayName,
    } : null,
    childCount: resource.childCount,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };

  if (resource.type === "media_file") {
    entry.media = {
      sourceType: resource.mediaSourceType ?? null,
      mediaKind: resource.mediaKind ?? null,
      mimeType: resource.mimeType ?? null,
      size: resource.size ?? null,
      duration: resource.duration ?? null,
    };
  }
  if (resource.type === "annotation_file") {
    entry.annotation = {
      revision: resource.revision ?? null,
      workflowStatus: resource.workflowStatus ?? null,
      mediaBinding: null,
    };
  }
  if (resource.type === "project") {
    entry.workflowStatus = resource.workflowStatus ?? null;
  }
  return entry;
}

function buildSummary(resources, externalLinkedMedia) {
  const byType = Object.fromEntries(
    ["project", "folder", "media_file", "annotation_file"].map((type) => [
      type,
      resources.filter((resource) => resource.type === type).length,
    ]),
  );
  const annotations = resources.filter(({ type }) => type === "annotation_file");
  const bindings = Object.fromEntries(
    ["bound", "unbound", "unresolved"].map((status) => [
      status,
      annotations.filter((resource) => resource.annotation.mediaBinding?.status === status).length,
    ]),
  );
  return {
    resourceCount: resources.length,
    topLevelProjectCount: resources.filter(
      (resource) => resource.type === "project" && resource.depth === 0,
    ).length,
    byType,
    annotationMediaBindings: bindings,
    externalLinkedMediaCount: externalLinkedMedia.length,
  };
}

function toCsv(resources) {
  const columns = [
    "root_project_id",
    "root_project_name",
    "path",
    "depth",
    "type",
    "id",
    "parent_id",
    "name",
    "owner_account",
    "child_count",
    "created_at",
    "updated_at",
    "media_source_type",
    "media_kind",
    "mime_type",
    "size_bytes",
    "duration_seconds",
    "annotation_revision",
    "workflow_status",
    "media_binding_status",
    "linked_media_id",
    "linked_media_name",
    "linked_media_path",
  ];
  const rows = resources.map((resource) => [
    resource.rootProjectId,
    resource.rootProjectName,
    resource.path,
    resource.depth,
    resource.type,
    resource.id,
    resource.parentId,
    resource.name,
    resource.owner?.accountName,
    resource.childCount,
    resource.createdAt,
    resource.updatedAt,
    resource.media?.sourceType,
    resource.media?.mediaKind,
    resource.media?.mimeType,
    resource.media?.size,
    resource.media?.duration,
    resource.annotation?.revision,
    resource.annotation?.workflowStatus ?? resource.workflowStatus,
    resource.annotation?.mediaBinding?.status,
    resource.annotation?.mediaBinding?.mediaResourceId,
    resource.annotation?.mediaBinding?.mediaName,
    resource.annotation?.mediaBinding?.mediaPath,
  ]);
  return `${[columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function mapWithConcurrency(items, concurrency, task) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

function parseArguments(rawArguments) {
  const values = new Map();
  for (let index = 0; index < rawArguments.length; index += 2) {
    const key = rawArguments[index];
    const value = rawArguments[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}.`);
    }
    values.set(key.slice(2), value);
  }
  return values;
}

function requiredArgument(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

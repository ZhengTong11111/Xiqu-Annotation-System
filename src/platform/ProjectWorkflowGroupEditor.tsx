import { Save, Search, UsersRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  ProjectWorkflowGroups,
  ResourceEntry,
  UserReference,
} from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";

export function ProjectWorkflowGroupEditor(props: {
  client: PlatformClient;
  resource: ResourceEntry;
  readOnly: boolean;
  onChanged: () => void | Promise<void>;
  onError: (message: string | null) => void;
}) {
  const canManage = !props.readOnly && props.resource.permission.capabilities
    .includes("manage_permissions");
  const [groups, setGroups] = useState<ProjectWorkflowGroups | null>(null);
  const [annotationIds, setAnnotationIds] = useState<Set<string>>(new Set());
  const [reviewIds, setReviewIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [accounts, setAccounts] = useState<UserReference[]>([]);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setGroups(null);
    setAnnotationIds(new Set());
    setReviewIds(new Set());
    setQuery("");
    setAccounts([]);
    if (!canManage) return () => { active = false; };
    setLoading(true);
    void props.client.getProjectWorkflowGroups(props.resource.id)
      .then((next) => {
        if (!active) return;
        setGroups(next);
        setAnnotationIds(new Set(next.annotation.map(({ id }) => id)));
        setReviewIds(new Set(next.review.map(({ id }) => id)));
      })
      .catch((error) => {
        if (active) props.onError(describeError(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [canManage, props.client, props.onError, props.resource.id]);

  useEffect(() => {
    let active = true;
    if (!canManage) return () => { active = false; };
    setSearching(true);
    const timer = window.setTimeout(() => {
      void props.client.listDirectoryUsers(query.trim() || undefined)
        .then((next) => {
          if (active) setAccounts(next);
        })
        .catch((error) => {
          if (active) props.onError(describeError(error));
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, query ? 180 : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [canManage, props.client, props.onError, query]);

  // 搜索结果与既有成员合并，确保停用或暂时不匹配关键词的成员仍可被看见和移出。
  const visibleAccounts = useMemo(() => {
    const byId = new Map<string, UserReference>();
    for (const account of [
      ...(groups?.annotation ?? []),
      ...(groups?.review ?? []),
      ...accounts,
    ]) byId.set(account.id, account);
    return [...byId.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName, "zh-CN") ||
      left.accountName.localeCompare(right.accountName));
  }, [accounts, groups]);

  const dirty = groups != null && (
    !setsEqual(annotationIds, new Set(groups.annotation.map(({ id }) => id))) ||
    !setsEqual(reviewIds, new Set(groups.review.map(({ id }) => id)))
  );

  if (!canManage) return null;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    props.onError(null);
    try {
      const next = await props.client.updateProjectWorkflowGroups(
        props.resource.id,
        {
          annotationUserIds: [...annotationIds].sort(),
          reviewUserIds: [...reviewIds].sort(),
        },
      );
      setGroups(next);
      setAnnotationIds(new Set(next.annotation.map(({ id }) => id)));
      setReviewIds(new Set(next.review.map(({ id }) => id)));
      await props.onChanged();
    } catch (error) {
      props.onError(describeError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="project-workflow-groups">
      <div className="resource-inspector-section-heading">
        <div>
          <strong><UsersRound size={15} /> 项目职责组</strong>
          <span>只表达分工，不会自动授予编辑或审核权限</span>
        </div>
      </div>
      <label className="project-workflow-search">
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索姓名或账号"
        />
      </label>
      <div className="project-workflow-member-header" aria-hidden="true">
        <span>账号</span><span>标注</span><span>审核</span>
      </div>
      <div className="project-workflow-member-list">
        {loading ? <p>正在读取职责组…</p> : null}
        {!loading && !visibleAccounts.length ? (
          <p>{searching ? "正在搜索…" : "没有匹配账号"}</p>
        ) : null}
        {visibleAccounts.map((account) => (
          <div key={account.id} className="project-workflow-member-row">
            <span title={account.accountName}>
              <strong>{account.displayName}</strong>
              <small>{account.accountName}</small>
            </span>
            <input
              type="checkbox"
              aria-label={`将 ${account.displayName} 加入标注组`}
              checked={annotationIds.has(account.id)}
              disabled={saving}
              onChange={() => setAnnotationIds((current) =>
                toggleSetValue(current, account.id))}
            />
            <input
              type="checkbox"
              aria-label={`将 ${account.displayName} 加入审核组`}
              checked={reviewIds.has(account.id)}
              disabled={saving}
              onChange={() => setReviewIds((current) =>
                toggleSetValue(current, account.id))}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        className="project-workflow-save"
        disabled={!dirty || saving || loading}
        onClick={() => void save()}
      >
        <Save size={15} /> {saving ? "正在保存…" : "保存职责组"}
      </button>
    </section>
  );
}

function toggleSetValue(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "项目职责组操作失败。";
}

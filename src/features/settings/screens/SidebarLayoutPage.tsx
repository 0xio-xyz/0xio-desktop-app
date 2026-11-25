import { useState } from "react";
import { useTranslation } from "src/i18n/react";
import { GripVertical } from "src/shared/ui/icons";
import Modal from "src/shared/ui/Modal";
import { Action } from "src/shared/ui/flat";
import { NAV_LABEL_KEYS } from "src/shared/layout/navCatalog";
import {
  FOCUS,
  Group,
  PillSelect,
  Row,
  SubPage,
  TextAction,
} from "src/features/settings/components/parts";
import {
  DEFAULT_GROUPS,
  DEFAULT_SIZES,
  SIZE_MAX,
  SIZE_MIN,
  type AppearanceSettings,
  type NavGroup,
} from "src/features/settings/services/appearance";

function SizeRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <Row label={label}>
      <input
        type="range"
        min={SIZE_MIN}
        max={SIZE_MAX}
        step={0.5}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-44 cursor-pointer accent-accent"
      />
      <span className="w-12 text-right text-[0.8125rem] text-content-muted tabular-nums">
        {value}px
      </span>
    </Row>
  );
}

export default function SidebarLayoutPage({
  settings,
  update,
  onBack,
}: {
  settings: AppearanceSettings;
  update: (next: AppearanceSettings) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dragGroupId, setDragGroupId] = useState<string | null>(null);
  const [groupDropIndex, setGroupDropIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ groupId: string; index: number } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; dest: string } | null>(null);
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  const setSize = (key: keyof AppearanceSettings["sizes"], value: number) =>
    update({ ...settings, sizes: { ...settings.sizes, [key]: value } });

  const setGroups = (groups: NavGroup[]) => update({ ...settings, groups });

  const moveItem = (path: string, toGroupId: string) => {
    setGroups(
      settings.groups.map((g) => ({
        ...g,
        paths:
          g.id === toGroupId
            ? [...g.paths.filter((p) => p !== path), path]
            : g.paths.filter((p) => p !== path),
      })),
    );
  };

  const previewGroups = (): NavGroup[] => {
    if (!dragGroupId || groupDropIndex === null) return settings.groups;
    const without = settings.groups.filter((g) => g.id !== dragGroupId);
    const moving = settings.groups.find((g) => g.id === dragGroupId);
    if (!moving) return settings.groups;
    const at = Math.max(0, Math.min(without.length, groupDropIndex));
    return [...without.slice(0, at), moving, ...without.slice(at)];
  };

  const commitGroupDrag = () => {
    if (dragGroupId && groupDropIndex !== null) setGroups(previewGroups());
    setDragGroupId(null);
    setGroupDropIndex(null);
  };

  const nudgeGroup = (groupId: string, dir: -1 | 1) => {
    const from = settings.groups.findIndex((g) => g.id === groupId);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= settings.groups.length) return;
    const next = [...settings.groups];
    [next[from], next[to]] = [next[to], next[from]];
    setGroups(next);
  };

  const nudge = (path: string, groupId: string, key: string) => {
    const gi = settings.groups.findIndex((g) => g.id === groupId);
    if (gi < 0) return;
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const target = settings.groups[gi + (key === "ArrowRight" ? 1 : -1)];
      if (target) moveItem(path, target.id);
      return;
    }
    const dir = key === "ArrowUp" ? -1 : 1;
    setGroups(
      settings.groups.map((g) => {
        if (g.id !== groupId) return g;
        const from = g.paths.indexOf(path);
        const to = from + dir;
        if (from < 0 || to < 0 || to >= g.paths.length) return g;
        const paths = [...g.paths];
        [paths[from], paths[to]] = [paths[to], paths[from]];
        return { ...g, paths };
      }),
    );
  };

  const previewPaths = (group: NavGroup): string[] => {
    if (!dragPath || !dropTarget) return group.paths;
    const without = group.paths.filter((p) => p !== dragPath);
    if (dropTarget.groupId !== group.id) return without;
    const at = Math.max(0, Math.min(without.length, dropTarget.index));
    return [...without.slice(0, at), dragPath, ...without.slice(at)];
  };

  const commitDrag = () => {
    if (dragPath && dropTarget) {
      setGroups(settings.groups.map((g) => ({ ...g, paths: previewPaths(g) })));
    }
    setDragPath(null);
    setDropTarget(null);
  };

  const nextGroupName = () => t("settings.newGroupName", { n: settings.groups.length + 1 });

  const addGroup = () => {
    const title = newGroupName.trim() || nextGroupName();
    const id = `g${Date.now().toString(36)}`;
    setGroups([...settings.groups, { id, title, paths: [] }]);
    setShowAddGroup(false);
    setNewGroupName("");
  };

  const renameGroup = (id: string, title: string) =>
    setGroups(settings.groups.map((g) => (g.id === id ? { ...g, title } : g)));

  const deleteGroup = (id: string, moveTo?: string) => {
    if (settings.groups.length <= 1) return;
    const victim = settings.groups.find((g) => g.id === id);
    const rest = settings.groups.filter((g) => g.id !== id);
    const destId = moveTo ?? rest[0].id;
    setGroups(
      rest.map((g) =>
        g.id === destId && victim?.paths.length
          ? { ...g, paths: [...g.paths, ...victim.paths] }
          : g,
      ),
    );
    setPendingDelete(null);
  };

  return (
    <SubPage title={t("settings.sidebarLayout")} onBack={onBack} backLabel={t("common.back")}>
      <Group
        caption={t("settings.sidebarSize")}
        right={
          <TextAction onClick={() => update({ ...settings, sizes: DEFAULT_SIZES })}>
            {t("settings.reset")}
          </TextAction>
        }
      >
        <SizeRow
          label={t("settings.groupHeading")}
          value={settings.sizes.categoryPx}
          onChange={(v) => setSize("categoryPx", v)}
        />
        <SizeRow
          label={t("settings.itemLabel")}
          value={settings.sizes.itemLabelPx}
          onChange={(v) => setSize("itemLabelPx", v)}
        />
        <SizeRow
          label={t("settings.itemIcon")}
          value={settings.sizes.itemIconPx}
          onChange={(v) => setSize("itemIconPx", v)}
        />
      </Group>

      <div className="flex min-h-6.75 items-center justify-between gap-4 pr-1 pl-4.5">
        <span className="tab-caps text-content-muted">{t("settings.sidebarGroups")}</span>
        <span className="flex items-center gap-1">
          <TextAction
            onClick={() => {
              setNewGroupName("");
              setShowAddGroup(true);
            }}
          >
            {t("settings.addGroup")}
          </TextAction>
          <TextAction onClick={() => setGroups(DEFAULT_GROUPS)}>{t("settings.reset")}</TextAction>
        </span>
      </div>

      {previewGroups().map((group) => (
        <div
          key={group.id}
          onDragOver={(e) => {
            if (dragGroupId) {
              e.preventDefault();
              const without = settings.groups.filter((g) => g.id !== dragGroupId);
              const base = without.findIndex((g) => g.id === group.id);
              if (base < 0) return;
              const box = e.currentTarget.getBoundingClientRect();
              setGroupDropIndex(e.clientY > box.top + box.height / 2 ? base + 1 : base);
              return;
            }
            if (!dragPath) return;
            e.preventDefault();
            if (e.target !== e.currentTarget) return;
            setDropTarget({
              groupId: group.id,
              index: group.paths.filter((p) => p !== dragPath).length,
            });
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragGroupId) commitGroupDrag();
            else commitDrag();
          }}
          className={`look-raise flex flex-col rounded-[18px] p-1 transition-colors duration-200 ease-out ${
            dragGroupId === group.id
              ? "bg-surface-card opacity-40"
              : dragPath && dropTarget?.groupId === group.id
                ? "bg-surface-highlight"
                : "bg-surface-card"
          }`}
        >
          <div
            className="flex min-h-11 items-center gap-2 px-3.5"
            draggable
            onDragStart={(e) => {
              setDragGroupId(group.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              setDragGroupId(null);
              setGroupDropIndex(null);
            }}
          >
            <span
              tabIndex={0}
              role="button"
              aria-label={t("settings.moveGroup", { name: group.title })}
              onKeyDown={(e) => {
                if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                e.preventDefault();
                nudgeGroup(group.id, e.key === "ArrowUp" ? -1 : 1);
              }}
              className={`shrink-0 cursor-grab rounded-md text-content-muted active:cursor-grabbing ${FOCUS}`}
            >
              <GripVertical size={14} />
            </span>
            <input
              value={group.title}
              onChange={(e) => renameGroup(group.id, e.target.value)}
              aria-label={t("settings.groupName")}
              className="min-w-0 flex-1 rounded-md bg-transparent px-1 text-body font-semibold text-content outline-none focus-visible:bg-surface-highlight"
            />
            {settings.groups.length > 1 && (
              <TextAction
                onClick={() => {
                  const rest = settings.groups.filter((g) => g.id !== group.id);
                  if (group.paths.length === 0) deleteGroup(group.id);
                  else setPendingDelete({ id: group.id, dest: rest[0].id });
                }}
              >
                {t("common.delete")}
              </TextAction>
            )}
          </div>
          {group.paths.length === 0 ? (
            <p className="px-3.5 pb-3 text-meta text-content-muted">{t("settings.groupEmpty")}</p>
          ) : (
            previewPaths(group).map((path) => (
              <div
                key={path}
                draggable
                tabIndex={0}
                role="button"
                aria-label={t("settings.moveItem", {
                  name: NAV_LABEL_KEYS[path] ? t(NAV_LABEL_KEYS[path]) : path,
                  group: group.title,
                })}
                onKeyDown={(e) => {
                  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
                  e.preventDefault();
                  nudge(path, group.id, e.key);
                }}
                onDragStart={(e) => {
                  setDragPath(path);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  setDragPath(null);
                  setDropTarget(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  commitDrag();
                }}
                onDragOver={(e) => {
                  if (!dragPath) return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (path === dragPath) return;
                  const without = group.paths.filter((p) => p !== dragPath);
                  const base = without.indexOf(path);
                  if (base < 0) return;
                  const box = e.currentTarget.getBoundingClientRect();
                  const below = e.clientY > box.top + box.height / 2;
                  setDropTarget({ groupId: group.id, index: below ? base + 1 : base });
                }}
                className={`flex min-h-11 cursor-grab items-center gap-3 rounded-[14px] px-3.5 transition-colors duration-200 ease-out hover:bg-surface-highlight active:cursor-grabbing ${FOCUS} ${
                  dragPath === path ? "opacity-40" : ""
                }`}
              >
                <GripVertical size={13} className="shrink-0 text-content-muted" />
                <span className="flex-1 truncate text-body text-content-secondary">
                  {NAV_LABEL_KEYS[path] ? t(NAV_LABEL_KEYS[path]) : path}
                </span>
                <PillSelect
                  value={group.id}
                  onChange={(id) => moveItem(path, id)}
                  options={settings.groups.map((g) => ({ value: g.id, label: g.title }))}
                  label={t("settings.groupFor", {
                    name: NAV_LABEL_KEYS[path] ? t(NAV_LABEL_KEYS[path]) : path,
                  })}
                />
              </div>
            ))
          )}
        </div>
      ))}

      <Modal
        isOpen={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title={t("settings.deleteGroup")}
        size="sm"
        hideClose
        look="ext"
      >
        {pendingDelete && (
          <div className="space-y-4">
            <p className="text-[0.8125rem] leading-relaxed text-content-secondary">
              {t("settings.deleteGroupNote", {
                count: settings.groups.find((g) => g.id === pendingDelete.id)?.paths.length ?? 0,
              })}
            </p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[0.8125rem] text-content-secondary">
                {t("settings.moveThemTo")}
              </span>
              <PillSelect
                value={pendingDelete.dest}
                onChange={(dest) => setPendingDelete({ ...pendingDelete, dest })}
                options={settings.groups
                  .filter((g) => g.id !== pendingDelete.id)
                  .map((g) => ({ value: g.id, label: g.title }))}
                label={t("settings.moveThemTo")}
              />
            </div>
            <div className="flex gap-2.5">
              <Action weight="raised" full onClick={() => setPendingDelete(null)}>
                {t("common.cancel")}
              </Action>
              <Action
                weight="primary"
                full
                onClick={() => deleteGroup(pendingDelete.id, pendingDelete.dest)}
              >
                {t("settings.deleteGroup")}
              </Action>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={showAddGroup}
        onClose={() => setShowAddGroup(false)}
        title={t("settings.newGroup")}
        size="sm"
        hideClose
        look="ext"
      >
        <div className="space-y-4">
          <input
            autoFocus
            value={newGroupName}
            aria-label={t("settings.groupName")}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addGroup();
            }}
            placeholder={nextGroupName()}
            className="w-full rounded-2xl bg-surface-highlight px-4 py-3 text-body text-content outline-none placeholder:text-content-muted"
          />
          <div className="flex gap-2.5">
            <Action weight="raised" full onClick={() => setShowAddGroup(false)}>
              {t("common.cancel")}
            </Action>
            <Action weight="primary" full onClick={addGroup}>
              {t("settings.addGroup")}
            </Action>
          </div>
        </div>
      </Modal>
    </SubPage>
  );
}

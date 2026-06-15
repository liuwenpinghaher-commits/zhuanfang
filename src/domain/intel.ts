// Automated-intelligence "IntelTask" system: persistent monitoring tasks that,
// when run, search the live web, triage the results, and produce an intel feed
// that can flow into knowledge debts / today's interview desk.
import type { IntelItem, IntelTask, KnowledgeDebt, ProductState, SearchProviderId } from "./types";
import { cloneState, makeId, nowIso } from "./utils";

export interface CreateIntelTaskInput {
  name: string;
  keywords: string[];
  provider?: SearchProviderId;
  frequency?: IntelTask["frequency"];
  relatedThemeIds?: string[];
  relatedDebtIds?: string[];
}

export interface TriagedIntelItem {
  title: string;
  url: string;
  publisher: string;
  summary: string;
  relevance: number;
  claims: string[];
  category: string;
}

export function createIntelTask(
  state: ProductState,
  input: CreateIntelTaskInput
): { task: IntelTask; nextState: ProductState } {
  const task: IntelTask = {
    id: makeId("intel-task"),
    name: input.name.trim() || "未命名情报任务",
    keywords: input.keywords.map((keyword) => keyword.trim()).filter(Boolean),
    provider: input.provider ?? state.systemConfig.search.activeProvider,
    frequency: input.frequency ?? "manual",
    relatedThemeIds: input.relatedThemeIds ?? [],
    relatedDebtIds: input.relatedDebtIds ?? [],
    status: "active",
    createdAt: nowIso()
  };
  const next = cloneState(state);
  next.intelTasks = [task, ...next.intelTasks];
  return { task, nextState: next };
}

export function ingestIntelItems(
  state: ProductState,
  task: IntelTask,
  items: TriagedIntelItem[]
): { count: number; nextState: ProductState } {
  const createdAt = nowIso();
  // Dedup against existing items AND against duplicates within this batch.
  const seenUrls = new Set(state.intelItems.map((item) => item.url));
  const fresh: TriagedIntelItem[] = [];
  for (const item of items) {
    if (item.url && !seenUrls.has(item.url)) {
      seenUrls.add(item.url);
      fresh.push(item);
    }
  }

  const intelItems: IntelItem[] = fresh.map((item) => ({
    id: makeId("intel-item"),
    taskId: task.id,
    taskName: task.name,
    title: item.title,
    url: item.url,
    publisher: item.publisher,
    summary: item.summary,
    relevance: item.relevance,
    claims: item.claims,
    category: item.category,
    status: "unread",
    topic: task.keywords.join(" "),
    createdAt
  }));

  const next = cloneState(state);
  next.intelItems = [...intelItems, ...next.intelItems];
  next.intelTasks = next.intelTasks.map((item) => (item.id === task.id ? { ...item, lastRunAt: createdAt } : item));
  return { count: intelItems.length, nextState: next };
}

export function updateIntelItemStatus(state: ProductState, itemId: string, status: IntelItem["status"]): ProductState {
  const next = cloneState(state);
  next.intelItems = next.intelItems.map((item) => (item.id === itemId ? { ...item, status } : item));
  return next;
}

export function deleteIntelTask(state: ProductState, taskId: string): ProductState {
  const next = cloneState(state);
  next.intelTasks = next.intelTasks.filter((task) => task.id !== taskId);
  next.intelItems = next.intelItems.filter((item) => item.taskId !== taskId);
  return next;
}

/** Promote an intel item into a reviewable knowledge debt (今日访谈台 integration). */
export function intelItemToKnowledgeDebt(
  state: ProductState,
  itemId: string
): { debt?: KnowledgeDebt; nextState: ProductState } {
  const item = state.intelItems.find((candidate) => candidate.id === itemId);
  if (!item) {
    return { nextState: state };
  }
  const createdAt = nowIso();
  const debt: KnowledgeDebt = {
    id: makeId("debt"),
    concept: item.title.slice(0, 40),
    context: `来自情报任务《${item.taskName}》：${item.summary}`,
    whyImportant: "外部情报指向一个值得补全的理解缺口。",
    status: "待了解",
    nextQuestion: `${item.title} 对你当前的判断意味着什么？`,
    updatedAt: createdAt
  };
  const next = cloneState(state);
  next.debts = [debt, ...next.debts];
  next.intelItems = next.intelItems.map((candidate) =>
    candidate.id === itemId ? { ...candidate, status: "saved" } : candidate
  );
  return { debt, nextState: next };
}

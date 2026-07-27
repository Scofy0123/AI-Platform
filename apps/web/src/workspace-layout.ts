export type SidePanelTab =
  | { kind: "plan" }
  | { kind: "outputs" }
  | { kind: "subagents" }
  | { kind: "sources" }
  | { kind: "subagent"; id: string }
  | { kind: "changes"; detailId: string | null }
  | { kind: "tool"; detailId: string | null };

export type BottomPanelTab = "terminal";

export interface WorkspaceLayoutState {
  pinnedSummaryOpen: boolean;
  sidePanel: {
    open: boolean;
    tab: SidePanelTab;
    width: number;
  };
  bottomPanel: {
    open: boolean;
    tab: BottomPanelTab;
    detailId: string | null;
    height: number;
  };
}

interface WorkspaceLayoutPreferences {
  pinnedSummaryOpen?: boolean;
  sidePanelOpen?: boolean;
  bottomPanelOpen?: boolean;
  sidePanelWidth?: number;
  bottomPanelHeight?: number;
}

export type WorkspaceLayoutAction =
  | { type: "TOGGLE_PINNED" }
  | { type: "OPEN_SIDE"; tab: SidePanelTab }
  | { type: "SELECT_SIDE_TAB"; tab: SidePanelTab }
  | { type: "CLOSE_SIDE" }
  | { type: "OPEN_BOTTOM"; tab: BottomPanelTab; detailId?: string | null }
  | { type: "SELECT_BOTTOM_TAB"; tab: BottomPanelTab; detailId?: string | null }
  | { type: "CLOSE_BOTTOM" }
  | { type: "RESIZE_SIDE"; width: number }
  | { type: "RESIZE_BOTTOM"; height: number }
  | { type: "RESET_THREAD" };

const DEFAULT_SIDE_WIDTH = 340;
const DEFAULT_BOTTOM_HEIGHT = 280;

export function createWorkspaceLayoutState(
  preferences: WorkspaceLayoutPreferences = {},
): WorkspaceLayoutState {
  return {
    pinnedSummaryOpen: preferences.pinnedSummaryOpen ?? false,
    sidePanel: {
      open: preferences.sidePanelOpen ?? false,
      tab: { kind: "plan" },
      width: bound(preferences.sidePanelWidth ?? DEFAULT_SIDE_WIDTH, 280, 560),
    },
    bottomPanel: {
      open: preferences.bottomPanelOpen ?? false,
      tab: "terminal",
      detailId: null,
      height: bound(preferences.bottomPanelHeight ?? DEFAULT_BOTTOM_HEIGHT, 180, 520),
    },
  };
}

export function reduceWorkspaceLayout(
  state: WorkspaceLayoutState,
  action: WorkspaceLayoutAction,
): WorkspaceLayoutState {
  switch (action.type) {
    case "TOGGLE_PINNED":
      return { ...state, pinnedSummaryOpen: !state.pinnedSummaryOpen };
    case "OPEN_SIDE":
      return { ...state, sidePanel: { ...state.sidePanel, open: true, tab: action.tab } };
    case "SELECT_SIDE_TAB":
      return { ...state, sidePanel: { ...state.sidePanel, tab: action.tab } };
    case "CLOSE_SIDE":
      return { ...state, sidePanel: { ...state.sidePanel, open: false } };
    case "OPEN_BOTTOM":
      return {
        ...state,
        bottomPanel: {
          ...state.bottomPanel,
          open: true,
          tab: action.tab,
          detailId: action.detailId ?? null,
        },
      };
    case "SELECT_BOTTOM_TAB":
      return {
        ...state,
        bottomPanel: {
          ...state.bottomPanel,
          tab: action.tab,
          detailId: action.detailId ?? null,
        },
      };
    case "CLOSE_BOTTOM":
      return { ...state, bottomPanel: { ...state.bottomPanel, open: false } };
    case "RESIZE_SIDE":
      return {
        ...state,
        sidePanel: { ...state.sidePanel, width: bound(action.width, 280, 560) },
      };
    case "RESIZE_BOTTOM":
      return {
        ...state,
        bottomPanel: { ...state.bottomPanel, height: bound(action.height, 180, 520) },
      };
    case "RESET_THREAD":
      return {
        ...state,
        sidePanel: {
          open: false,
          tab: { kind: "plan" },
          width: state.sidePanel.width,
        },
        bottomPanel: {
          open: false,
          tab: "terminal",
          detailId: null,
          height: state.bottomPanel.height,
        },
      };
  }
}

function bound(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

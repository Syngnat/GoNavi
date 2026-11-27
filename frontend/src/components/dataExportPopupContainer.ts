// 浮层与可拖拽弹窗共用坐标系，避免弹窗移动后仍停留在首次打开时的屏幕坐标。
export const resolveDataExportPopupContainer = (triggerNode?: HTMLElement | null): HTMLElement => (
  triggerNode?.closest<HTMLElement>('.gn-resizable-draggable-modal') ?? document.body
);

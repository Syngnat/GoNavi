export const sameEditorPosition = (left: any, right: any): boolean => (
  Number(left?.lineNumber) === Number(right?.lineNumber)
  && Number(left?.column) === Number(right?.column)
);

export const sameEditorRange = (left: any, right: any): boolean => (
  Number(left?.startLineNumber) === Number(right?.startLineNumber)
  && Number(left?.startColumn) === Number(right?.startColumn)
  && Number(left?.endLineNumber) === Number(right?.endLineNumber)
  && Number(left?.endColumn) === Number(right?.endColumn)
);

export const isSelectionEmpty = (selection: any): boolean => (
  !selection
  || (
    Number(selection.startLineNumber) === Number(selection.endLineNumber)
    && Number(selection.startColumn) === Number(selection.endColumn)
  )
);

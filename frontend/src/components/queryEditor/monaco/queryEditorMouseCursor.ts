export const setQueryEditorMouseCursor = (
    editor: any,
    cursor: '' | 'pointer',
) => {
    const domNode = editor?.getDomNode?.();
    if (domNode?.style) {
        domNode.style.cursor = cursor;
    }
};
